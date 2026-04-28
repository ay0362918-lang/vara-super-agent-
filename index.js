import { GearApi, ProgramMetadata } from "@gear-js/api";
import { Keyring } from "@polkadot/keyring";
import { setTimeout as wait } from "timers/promises";
import fs from "fs";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

/**
 * SEASON 2 CHIP FARMER
 * -------------------
 * Optimized for winning bets and accumulating real CHIPs.
 * Uses market data to pick favored outcomes (>85% probability).
 */

const RPC = "wss://rpc.vara.network";
const BASKET_MARKET = "0xe5dd153b813c768b109094a9e2eb496c38216b1dbe868391f1d20ac927b7d2c2";
const BET_TOKEN = "0x186f6cda18fea13d9fc5969eec5a379220d6726f64c1d5f4b346e89271f917bc";
const BET_LANE = "0x35848dea0ab64f283497deaff93b12fe4d17649624b2cd5149f253ef372b29dc";

const VOUCHER_URL = "https://voucher-backend-production-5a1b.up.railway.app/voucher";
const BET_QUOTE_URL = "https://bet-quote-service-production.up.railway.app/api/bet-lane/quote";
const POLYMARKET_API = "https://gamma-api.polymarket.com/markets";

const IDL_BASKET = "C:/Users/yezir/.agents/skills/polybaskets-skills/idl/polymarket-mirror.idl";
const IDL_TOKEN = "C:/Users/yezir/.agents/skills/polybaskets-skills/idl/bet_token_client.idl";
const IDL_LANE = "C:/Users/yezir/.agents/skills/polybaskets-skills/idl/bet_lane_client.idl";

let api, account, hexAddress, voucherId;
let metaBasket, metaToken, metaLane;

function log(...args) {
    console.log(`[${new Date().toLocaleTimeString()}] 💰 [CHIP-FARMER]`, ...args);
}

async function init() {
    log("Initializing Gear API and Loading Metadata...");
    api = await GearApi.create({ providerAddress: RPC });
    const keyring = new Keyring({ type: "sr25519" });
    account = keyring.addFromUri(process.env.PRIVATE_KEY);
    hexAddress = "0xa043f97bc85c4c43e67244fc6d19a7d796b88adda32c766778ceb948699c7d76";

    metaBasket = ProgramMetadata.from(fs.readFileSync(IDL_BASKET, "utf8"));
    metaToken = ProgramMetadata.from(fs.readFileSync(IDL_TOKEN, "utf8"));
    metaLane = ProgramMetadata.from(fs.readFileSync(IDL_LANE, "utf8"));
    
    log("Metadata loaded. Farmer ready.");
}

async function ensureVoucher() {
    try {
        const res = await fetch(`${VOUCHER_URL}/${hexAddress}`);
        const data = await res.json();
        if (data.voucherId && data.canTopUpNow === false) {
            voucherId = data.voucherId;
            return;
        }
        const postRes = await fetch(VOUCHER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ account: hexAddress, programs: [BASKET_MARKET, BET_TOKEN, BET_LANE] })
        });
        const postData = await postRes.json();
        voucherId = postData.voucherId || data.voucherId;
    } catch (e) { log("Voucher error:", e.message); }
}

async function getBalance() {
    try {
        const res = await api.programState.read({ programId: BET_TOKEN, payload: { BalanceOf: hexAddress } }, metaToken);
        return BigInt(res.toString());
    } catch (e) { return 0n; }
}

async function fetchFavoredMarkets() {
    try {
        const now = new Date();
        const twentyFourHoursLater = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        
        log(`Searching for markets ending before ${twentyFourHoursLater.toLocaleTimeString()}...`);
        
        // Filter for markets ending soon (within 24h) and sort by end_date (ascending)
        const url = `${POLYMARKET_API}?closed=false&order=end_date&ascending=true&limit=30&end_date_max=${twentyFourHoursLater.toISOString()}`;
        const res = await fetch(url);
        const markets = await res.json();
        
        return markets.map(m => {
            const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [0.5, 0.5];
            const probYes = parseFloat(prices[0]);
            const probNo = parseFloat(prices[1]);
            
            let selectedOutcome = "YES";
            let probability = probYes;
            
            if (probNo > probYes) {
                selectedOutcome = "NO";
                probability = probNo;
            }
            
            return {
                id: String(m.id),
                slug: m.slug,
                selectedOutcome,
                probability,
                endDate: new Date(m.endDate)
            };
        }).filter(m => m.probability > 0.85); // High confidence + Fast resolution
    } catch (e) { 
        log("Market fetch error:", e.message);
        return []; 
    }
}

async function claimAllRewards() {
    try {
        log("Checking for settled bets to claim rewards...");
        const res = await api.programState.read({ programId: BET_LANE, payload: { GetPositions: [hexAddress, 0, 50] } }, metaLane);
        const positions = res?.ok || [];
        
        for (const pos of positions) {
            if (pos.position && !pos.position.claimed) {
                const basketId = pos.basket_id;
                log(`Attempting to claim rewards for Basket ID: ${basketId}...`);
                const message = { destination: BET_LANE, payload: { Claim: basketId }, gasLimit: 35000000000, value: 0, prepaid: true };
                await api.message.send(message, metaLane).signAndSend(account, { voucherId });
                log(`✅ Claim sent for ${basketId}`);
                await wait(2000);
            }
        }
    } catch (e) {
        log("Claim rewards error:", e.message);
    }
}

async function farmCycle() {
    await ensureVoucher();
    await claimHourly();
    await claimAllRewards();

    const balance = await getBalance();
    log(`Current CHIP Balance: ${(Number(balance) / 1e12).toFixed(2)}`);

    if (balance < 1000000000000n) { // Need at least 1 CHIP to bet
        log("Insufficient balance for betting. Waiting for claim...");
        return;
    }

    // Determine bet amount: Bet 100% of balance to maximize CHIP-to-VARA conversion
    let betAmount = balance;
    if (betAmount < 1000000000000n) { // Minimum 1 CHIP
        log("Insufficient balance for betting. Waiting for claim...");
        return;
    }
    
    // Safety cap at 1,000,000 CHIP just in case, but usually we want to bet it all
    const cap = 1000000000000000000n; 
    if (betAmount > cap) betAmount = cap;

    log(`Planning MAX bet of ${(Number(betAmount) / 1e12).toFixed(2)} CHIP on favored outcomes...`);

    const favored = await fetchFavoredMarkets();
    if (favored.length < 1) {
        log("No highly favored markets found right now. Skipping cycle.");
        return;
    }

    // Pick the top 2 markets ending SOONEST that are still favored
    const targetMarkets = favored.sort((a,b) => a.endDate - b.endDate).slice(0, 2);
    const items = targetMarkets.map(m => ({
        poly_market_id: m.id,
        poly_slug: m.slug.slice(0, 128),
        weight_bps: 10000 / targetMarkets.length,
        selected_outcome: m.selectedOutcome
    }));

    log(`Creating Safe Basket with outcomes: ${targetMarkets.map(m => `${m.slug} (${m.selectedOutcome} @ ${(m.probability*100).toFixed(0)}%)`).join(", ")}`);

    // 1. Create Basket
    const createPayload = { CreateBasket: ["SafeFarmer", "Season 2 Chip Accumulator", items, "Bet"] };
    const createMsg = { destination: BASKET_MARKET, payload: createPayload, gasLimit: 35000000000, value: 0, prepaid: true };
    
    let basketId;
    const createExt = api.message.send(createMsg, metaBasket);
    const result = await new Promise((resolve) => {
        createExt.signAndSend(account, { voucherId }, ({ status, events }) => {
            if (status.isInBlock) {
                // Find basket ID in events
                events.forEach(({ event }) => {
                    if (event.method === 'UserMessageSent') {
                        // In Gear, the ID is returned in the message reply or we can query it
                    }
                });
                resolve(true);
            }
        });
    });

    // For simplicity, we'll query the last basket created by this user
    await wait(3000);
    const positions = await api.programState.read({ programId: BASKET_MARKET, payload: { GetPositions: hexAddress } }, metaBasket);
    // Find the latest basket ID (highest ID)
    const latestPos = positions.sort((a,b) => Number(b.basket_id) - Number(a.basket_id))[0];
    basketId = latestPos ? latestPos.basket_id : null;

    if (!basketId) {
        log("Could not identify new basket ID. Skipping bet.");
        return;
    }

    log(`Targeting Basket ID: ${basketId}`);

    // 2. Get Quote
    const quoteRes = await fetch(BET_QUOTE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: hexAddress, basketId: Number(basketId), amount: betAmount.toString(), targetProgramId: BET_LANE })
    });
    const quote = await quoteRes.json();
    if (!quote || quote.error) {
        log("Quote failed:", quote?.error);
        return;
    }

    // 3. Approve
    log("Approving CHIP for bet...");
    const appMsg = { destination: BET_TOKEN, payload: { Approve: [BET_LANE, betAmount.toString()] }, gasLimit: 25000000000, value: 0, prepaid: true };
    await api.message.send(appMsg, metaToken).signAndSend(account, { voucherId });
    await wait(2000);

    // 4. Place Bet
    log("Placing Smart Bet...");
    const betMsg = { destination: BET_LANE, payload: { PlaceBet: [basketId, betAmount.toString(), quote] }, gasLimit: 45000000000, value: 0, prepaid: true };
    await api.message.send(betMsg, metaLane).signAndSend(account, { voucherId });
    log("✅ Bet Placed. Success chance optimized.");
}

async function main() {
    await init();
    while (true) {
        try {
            await farmCycle();
            log("Sleeping for 5 minutes...");
            await wait(5 * 60 * 1000);
        } catch (e) {
            log("Cycle error:", e.message);
            await wait(30000);
        }
    }
}

main().catch(e => console.error(e));
