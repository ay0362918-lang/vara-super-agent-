import { GearApi } from "@gear-js/api";
import { Keyring } from "@polkadot/keyring";
import { setTimeout as wait } from "timers/promises";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

console.log("🌾 POLYBASKETS SEASON 2 CHIP FARMER STARTING...");

// --- CONFIG ---
const RPC = "wss://rpc.vara.network";
const BASKET_MARKET = "0xe5dd153b813c768b109094a9e2eb496c38216b1dbe868391f1d20ac927b7d2c2";
const BET_TOKEN = "0x186f6cda18fea13d9fc5969eec5a379220d6726f64c1d5f4b346e89271f917bc";
const BET_LANE = "0x35848dea0ab64f283497deaff93b12fe4d17649624b2cd5149f253ef372b29dc";

const VOUCHER_URL = "https://voucher-backend-production-5a1b.up.railway.app/voucher";
const BET_QUOTE_URL = "https://bet-quote-service-production.up.railway.app/api/bet-lane/quote";
const POLYMARKET_API = "https://gamma-api.polymarket.com/markets";

// Bet 10 CHIP per bet - lets us bet MANY times on many different baskets
const BET_AMOUNT = "10000000000000"; // 10 CHIP
const AGENT_NAME = process.env.AGENT_NAME || "yezoooooo";

// --- STATE ---
let api;
let account;
let hexAddress;
let voucherId;

function log(...args) {
    console.log(`[${new Date().toLocaleTimeString()}] 🌾 [FARMER]`, ...args);
}

async function init() {
    log("🔌 Connecting to Vara...");
    api = await GearApi.create({ providerAddress: RPC });

    const keyring = new Keyring({ type: "sr25519" });
    if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY missing in .env");
    account = keyring.addFromUri(process.env.PRIVATE_KEY);
    hexAddress = "0xa043f97bc85c4c43e67244fc6d19a7d796b88adda32c766778ceb948699c7d76";

    log("✅ Connected:", account.address);
}

async function ensureVoucher() {
    try {
        log("🎫 Checking voucher...");
        const res = await fetch(`${VOUCHER_URL}/${hexAddress}`);
        const data = await res.json();

        if (data.voucherId && data.canTopUpNow === false) {
            log("✅ Voucher active:", data.voucherId);
            voucherId = data.voucherId;
            return;
        }

        const postRes = await fetch(VOUCHER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ account: hexAddress, programs: [BASKET_MARKET, BET_TOKEN, BET_LANE] })
        });

        const postData = await postRes.json();
        if (postData.voucherId) {
            log("✅ Voucher ready:", postData.voucherId);
            voucherId = postData.voucherId;
        } else if (postRes.status === 429) {
            if (data.voucherId) voucherId = data.voucherId;
        }
    } catch (err) {
        log("⚠️ Voucher error:", err.message);
    }
}

async function claimCHIP() {
    if (!voucherId) return false;
    try {
        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const execFileAsync = promisify(execFile);
        const home = process.env.HOME || process.env.USERPROFILE || "";

        const idlPath = [
            process.env.BET_TOKEN_IDL,
            process.env.POLYBASKETS_SKILLS_DIR ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "bet_token_client.idl") : null,
            join(process.cwd(), "skills", "idl", "bet_token_client.idl"),
            join(home, ".agents", "skills", "polybaskets-skills", "idl", "bet_token_client.idl")
        ].filter(Boolean).find(p => existsSync(p));

        if (!idlPath) { log("❌ Claim: IDL not found"); return false; }

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        log("🪙 Claiming hourly CHIP...");
        const { stdout } = await execFileAsync(
            "vara-wallet",
            [...signerArgs, "call", BET_TOKEN, "BetToken/Claim", "--args", "[]", "--voucher", voucherId, "--gas-limit", "25000000000", "--idl", idlPath],
            { maxBuffer: 1024 * 1024 * 4, timeout: 120000 }
        );

        const parsed = JSON.parse(stdout.trim());
        if (parsed?.result === false) { log("ℹ️ Claim not available yet"); return false; }
        log("✅ CHIP Claimed!");
        return true;
    } catch (err) {
        const detail = err?.stderr?.trim?.() || err?.stdout?.trim?.() || err?.message || "";
        if (detail.includes("ClaimTooEarly") || detail.includes("ClaimNotAvailable")) {
            log("ℹ️ Claim not available yet");
        } else {
            log("❌ Claim error:", detail.slice(0, 200));
        }
        return false;
    }
}

// Fetch markets ending within 24h, sorted by soonest resolution, with highest probability
async function fetchFastFavoredMarkets() {
    try {
        const now = new Date();
        const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        log("🔍 Searching for fast-resolving favored markets (ending <24h)...");
        const url = `${POLYMARKET_API}?closed=false&order=end_date&ascending=true&limit=50&end_date_max=${in24h.toISOString()}`;
        const res = await fetch(url);
        const markets = await res.json();

        const candidates = markets
            .map(m => {
                const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [0.5, 0.5];
                const probYes = parseFloat(prices[0]);
                const probNo = parseFloat(prices[1]);
                const selectedOutcome = probNo > probYes ? "NO" : "YES";
                const probability = Math.max(probYes, probNo);
                return {
                    poly_market_id: String(m.id),
                    poly_slug: m.slug,
                    selectedOutcome,
                    probability,
                    endDate: new Date(m.endDate),
                    question: m.question
                };
            })
            .filter(m => m.probability > 0.80); // 80%+ confidence for fast markets

        log(`✅ Found ${candidates.length} fast, favored markets`);
        if (candidates.length > 0) {
            candidates.slice(0, 3).forEach(m => log(`  ↳ ${m.poly_slug} | ${m.selectedOutcome} @ ${(m.probability * 100).toFixed(0)}% | ends ${m.endDate.toLocaleTimeString()}`));
        }
        return candidates;
    } catch (e) {
        log("❌ Market fetch error:", e.message);
        return [];
    }
}

async function createBasket(market1, market2) {
    if (!voucherId) return null;
    try {
        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const execFileAsync = promisify(execFile);
        const home = process.env.HOME || process.env.USERPROFILE || "";

        const idlPath = [
            process.env.POLYBASKETS_IDL,
            process.env.POLYBASKETS_SKILLS_DIR ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "polymarket-mirror.idl") : null,
            join(process.cwd(), "skills", "idl", "polymarket-mirror.idl"),
            join(home, ".agents", "skills", "polybaskets-skills", "idl", "polymarket-mirror.idl")
        ].filter(Boolean).find(p => existsSync(p));

        if (!idlPath) { log("❌ Basket: IDL not found"); return null; }

        const items = [market1, market2].map(m => ({
            poly_market_id: m.poly_market_id,
            poly_slug: m.poly_slug.slice(0, 128),
            weight_bps: 5000,
            selected_outcome: m.selectedOutcome
        }));

        const basketName = `Farm-${Date.now().toString(36)}`.slice(0, 32);
        const argsJson = JSON.stringify([basketName, "S2 Fast Farm", items, "Bet"]);

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        log(`🏗️ Creating basket: ${market1.poly_slug} (${market1.selectedOutcome}) + ${market2.poly_slug} (${market2.selectedOutcome})`);

        const { stdout } = await execFileAsync(
            "vara-wallet",
            [...signerArgs, "call", BASKET_MARKET, "BasketMarket/CreateBasket", "--voucher", voucherId, "--args", argsJson, "--gas-limit", "35000000000", "--idl", idlPath],
            { maxBuffer: 1024 * 1024 * 4, timeout: 120000 }
        );

        const raw = stdout.trim();
        let basketId = null;
        try {
            const parsed = JSON.parse(raw);
            basketId = parsed?.result ?? parsed?.ok ?? parsed;
        } catch {
            const match = raw.match(/\d+/g);
            if (match?.length) basketId = match[match.length - 1];
        }

        if (!basketId && basketId !== 0) { log("❌ Could not parse basket ID from:", raw.slice(0, 200)); return null; }

        basketId = String(basketId);
        log(`🎯 Basket created: ID ${basketId}`);
        return basketId;
    } catch (err) {
        log("❌ Basket error:", (err?.stderr?.trim?.() || err?.message || "").slice(0, 300));
        return null;
    }
}

async function getQuote(basketId) {
    try {
        await wait(2000); // Give indexer time to see basket
        const body = { user: hexAddress, basketId: Number(basketId), amount: BET_AMOUNT, targetProgramId: BET_LANE };
        const res = await fetch(BET_QUOTE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data?.error || `HTTP ${res.status}`);
        log("✅ Quote received");
        return data;
    } catch (err) {
        log("❌ Quote error:", err.message);
        return null;
    }
}

async function approveBetLane(amount) {
    if (!voucherId) return false;
    try {
        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const execFileAsync = promisify(execFile);
        const home = process.env.HOME || process.env.USERPROFILE || "";

        const idlPath = [
            process.env.BET_TOKEN_IDL,
            process.env.POLYBASKETS_SKILLS_DIR ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "bet_token_client.idl") : null,
            join(process.cwd(), "skills", "idl", "bet_token_client.idl"),
            join(home, ".agents", "skills", "polybaskets-skills", "idl", "bet_token_client.idl")
        ].filter(Boolean).find(p => existsSync(p));

        if (!idlPath) return false;

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        const argsJson = `["${BET_LANE}", ${Number(amount)}]`;
        const { stdout } = await execFileAsync(
            "vara-wallet",
            [...signerArgs, "call", BET_TOKEN, "BetToken/Approve", "--args", argsJson, "--voucher", voucherId, "--gas-limit", "25000000000", "--idl", idlPath],
            { maxBuffer: 1024 * 1024 * 4, timeout: 120000 }
        );

        const parsed = JSON.parse(stdout?.trim() || "{}");
        return parsed?.result === true;
    } catch { return false; }
}

async function placeBet(basketId, quote) {
    if (!voucherId) return false;
    try {
        const approved = await approveBetLane(BET_AMOUNT);
        if (!approved) { log("⚠️ Approval failed, skipping bet"); return false; }

        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const execFileAsync = promisify(execFile);
        const home = process.env.HOME || process.env.USERPROFILE || "";

        const idlPath = [
            process.env.BET_LANE_IDL,
            process.env.POLYBASKETS_SKILLS_DIR ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "bet_lane_client.idl") : null,
            join(process.cwd(), "skills", "idl", "bet_lane_client.idl"),
            join(home, ".agents", "skills", "polybaskets-skills", "idl", "bet_lane_client.idl")
        ].filter(Boolean).find(p => existsSync(p));

        if (!idlPath) { log("❌ Bet: IDL not found"); return false; }

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        const argsJson = JSON.stringify([Number(basketId), BET_AMOUNT, quote]);

        log(`💰 Placing ${Number(BET_AMOUNT) / 1e12} CHIP bet on basket ${basketId}...`);
        const { stdout, stderr } = await execFileAsync(
            "vara-wallet",
            [...signerArgs, "call", BET_LANE, "BetLane/PlaceBet", "--args", argsJson, "--voucher", voucherId, "--gas-limit", "60000000000", "--idl", idlPath],
            { maxBuffer: 1024 * 1024 * 4, timeout: 120000 }
        );

        if (stderr?.trim()) log("ℹ️", stderr.trim());
        log("✅ BET PLACED:", stdout?.trim().slice(0, 200));
        return true;
    } catch (err) {
        log("❌ Bet error:", (err?.stderr?.trim?.() || err?.message || "").slice(0, 300));
        return false;
    }
}

async function farmCycle() {
    await ensureVoucher();
    await claimCHIP();

    const markets = await fetchFastFavoredMarkets();

    if (markets.length < 2) {
        log("⚠️ Not enough fast favored markets. Relaxing filter...");
        // Fallback: just pick any 2 markets ending within 24h regardless of probability
        const fallbackRes = await fetch(`${POLYMARKET_API}?closed=false&order=end_date&ascending=true&limit=10&end_date_max=${new Date(Date.now() + 24*60*60*1000).toISOString()}`);
        const fallback = await fallbackRes.json();
        if (fallback.length < 2) { log("⚠️ No markets available at all, sleeping..."); return; }
        markets.push(...fallback.slice(0, 2).map(m => ({
            poly_market_id: String(m.id),
            poly_slug: m.slug,
            selectedOutcome: Math.random() > 0.5 ? "YES" : "NO",
            probability: 0.5
        })));
    }

    // --- CORE STRATEGY: Place as many bets as possible on fast-resolving markets ---
    // Pick the 2 soonest-ending markets as the basket
    const [market1, market2] = markets.slice(0, 2);

    const basketId = await createBasket(market1, market2);
    if (!basketId) return;

    const quote = await getQuote(basketId);
    if (!quote) return;

    await placeBet(basketId, quote);
}

async function main() {
    await init();
    await ensureVoucher();

    // Register agent name once
    log("📝 Skipping registration (already registered as yezoooooo)");

    log("🚀 CHIP FARMER LOOP STARTED — Targeting fast-resolving markets");

    while (true) {
        try {
            await farmCycle();
            log("⏳ Next cycle in 30s...");
            await wait(2000); // 30s between cycles — bet continuously
        } catch (err) {
            log("💥 Cycle error:", err.message);
            await wait(15000);
        }
    }
}

main().catch(err => {
    console.error("💥 Fatal:", err);
    process.exit(1);
});
