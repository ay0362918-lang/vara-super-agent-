import { GearApi, decodeAddress } from "@gear-js/api";
import { Keyring } from "@polkadot/keyring";
import { u8aToHex } from "@polkadot/util";
import { setTimeout as wait } from "timers/promises";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

console.log("🔥 POLYBASKETS TURBO CREATOR AGENT STARTING...");

// --- CONFIG ---
const RPC = "wss://rpc.vara.network";
const BASKET_MARKET = "0xe5dd153b813c768b109094a9e2eb496c38216b1dbe868391f1d20ac927b7d2c2";

const VOUCHER_URL = "https://voucher-backend-production-5a1b.up.railway.app/voucher";
const POLYMARKET_API = "https://gamma-api.polymarket.com/markets";

const AGENT_NAME = process.env.AGENT_NAME || "turbo-maker";

// --- STATE ---
let api;
let account;
let hexAddress;
let voucherId;

function log(...args) {
    console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

async function init() {
    log("🔌 Connecting to Vara...");
    api = await GearApi.create({ providerAddress: RPC });

    const keyring = new Keyring({ type: "sr25519" });
    if (!process.env.PRIVATE_KEY) {
        throw new Error("PRIVATE_KEY missing in .env");
    }
    account = keyring.addFromUri(process.env.PRIVATE_KEY);

    // Force the correct 66-char hex address for this specific wallet
    // YOU SHOULD UPDATE THIS HEX ADDRESS FOR THE NEW SERVER!
    hexAddress = "0xa043f97bc85c4c43e67244fc6d19a7d796b88adda32c766778ceb948699c7d76";

    log("✅ Connected:", account.address);
    log("🆔 Hex Address:", hexAddress);
}

async function ensureVoucher() {
    try {
        log("🎫 Checking voucher status...");
        const res = await fetch(`${VOUCHER_URL}/${hexAddress}`);
        const data = await res.json();

        if (data.voucherId && data.canTopUpNow === false) {
            log("✅ Voucher active:", data.voucherId);
            voucherId = data.voucherId;
            return;
        }

        log("🆕 Requesting/Topping up voucher...");
        const postRes = await fetch(VOUCHER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                account: hexAddress,
                programs: [BASKET_MARKET] // ONLY Basket Market needed for this script
            })
        });

        const postData = await postRes.json();
        if (postData.voucherId) {
            log("✅ Voucher ready:", postData.voucherId);
            voucherId = postData.voucherId;
        } else if (postRes.status === 429) {
            log("⏳ Rate limited, using existing voucher if available");
            if (data.voucherId) voucherId = data.voucherId;
        }
    } catch (err) {
        log("⚠️ Voucher error:", err.message);
    }
}

async function registerAgent() {
    if (!voucherId) return false;

    try {
        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");

        const execFileAsync = promisify(execFile);
        const home = process.env.HOME || process.env.USERPROFILE || "";

        const idlCandidates = [
            process.env.POLYBASKETS_IDL,
            process.env.POLYBASKETS_SKILLS_DIR
                ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "polymarket-mirror.idl")
                : null,
            join(process.cwd(), "skills", "idl", "polymarket-mirror.idl"),
            join(home, ".agents", "skills", "polybaskets-skills", "idl", "polymarket-mirror.idl")
        ].filter(Boolean);

        const idlPath = idlCandidates.find((p) => existsSync(p));

        if (!idlPath) {
            log("❌ Register error: polymarket-mirror.idl not found");
            return false;
        }

        if (!process.env.PRIVATE_KEY) {
            log("❌ Register error: PRIVATE_KEY missing");
            return false;
        }

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        const argsJson = JSON.stringify([AGENT_NAME]);

        await execFileAsync("vara-wallet", ["config", "set", "network", "mainnet"], {
            maxBuffer: 1024 * 1024,
            timeout: 60000
        });

        log("📝 Registering agent name on-chain...");

        const { stdout, stderr } = await execFileAsync(
            "vara-wallet",
            [
                ...signerArgs,
                "call",
                BASKET_MARKET,
                "BasketMarket/RegisterAgent",
                "--args",
                argsJson,
                "--voucher",
                voucherId,
                "--gas-limit",
                "15000000000",
                "--idl",
                idlPath
            ],
            {
                maxBuffer: 1024 * 1024 * 4,
                timeout: 120000
            }
        );

        if (stderr && stderr.trim()) {
            log("ℹ️ vara-wallet:", stderr.trim());
        }

        if (stdout && stdout.trim()) {
            log("📄 Register response:", stdout.trim());
        }

        log("✅ Registration submitted");
        return true;
    } catch (err) {
        const detail =
            err?.stderr?.trim?.() ||
            err?.stdout?.trim?.() ||
            err?.message ||
            String(err);

        log("ℹ️ Registration note:", detail);
        return false;
    }
}

async function fetchMarkets() {
    try {
        log("🔍 Fetching active Polymarket markets...");
        const now = new Date();
        const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
        const res = await fetch(`${POLYMARKET_API}?closed=false&order=volume24hr&ascending=false&end_date_min=${oneHourLater.toISOString()}&limit=10`);

        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const markets = await res.json();

        return markets.map(m => ({
            poly_market_id: String(m.id),
            poly_slug: m.slug,
            question: m.question,
            outcomePrices: m.outcomePrices ? JSON.parse(m.outcomePrices) : []
        })).filter(m => m.outcomePrices && m.outcomePrices.length >= 2);
    } catch (err) {
        log("❌ Market fetch error:", err.message);
        return [];
    }
}

async function createAutonomousBasket() {
    if (!voucherId) return null;

    try {
        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");

        const execFileAsync = promisify(execFile);

        const markets = await fetchMarkets();
        if (markets.length < 2) {
            log("⚠️ Not enough active markets found to create a basket");
            return null;
        }

        const selected = [];
        const usedIndices = new Set();
        while (selected.length < 2) {
            const idx = Math.floor(Math.random() * markets.length);
            if (!usedIndices.has(idx)) {
                selected.push(markets[idx]);
                usedIndices.add(idx);
            }
        }

        log(`🏗️ Creating basket with: ${selected.map(m => m.poly_slug).join(", ")}`);

        const items = selected.map(m => ({
            poly_market_id: String(m.poly_market_id),
            poly_slug: String(m.poly_slug).slice(0, 128),
            weight_bps: 5000,
            selected_outcome: Math.random() > 0.5 ? "YES" : "NO"
        }));

        const basketName = `Turbo-${AGENT_NAME}-${Math.random().toString(36).substring(2, 7)}`.slice(0, 128);
        const description = "Ultra-fast basket created by Turbo Agent".slice(0, 512);
        const home = process.env.HOME || process.env.USERPROFILE || "";

        const idlCandidates = [
            process.env.POLYBASKETS_IDL,
            process.env.POLYBASKETS_SKILLS_DIR
                ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "polymarket-mirror.idl")
                : null,
            join(process.cwd(), "skills", "idl", "polymarket-mirror.idl"),
            join(home, ".agents", "skills", "polybaskets-skills", "idl", "polymarket-mirror.idl")
        ].filter(Boolean);

        const idlPath = idlCandidates.find((p) => existsSync(p));

        if (!idlPath) {
            log("❌ Basket creation error: polymarket-mirror.idl not found");
            return null;
        }

        if (!process.env.PRIVATE_KEY) {
            log("❌ Basket creation error: PRIVATE_KEY missing");
            return null;
        }

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        const argsJson = JSON.stringify([
            basketName,
            description,
            items,
            "Bet"
        ]);

        await execFileAsync("vara-wallet", ["config", "set", "network", "mainnet"], {
            maxBuffer: 1024 * 1024,
            timeout: 60000
        });

        const { stdout, stderr } = await execFileAsync(
            "vara-wallet",
            [
                ...signerArgs,
                "call",
                BASKET_MARKET,
                "BasketMarket/CreateBasket",
                "--voucher",
                voucherId,
                "--args",
                argsJson,
                "--gas-limit",
                "35000000000",
                "--idl",
                idlPath
            ],
            {
                maxBuffer: 1024 * 1024 * 4,
                timeout: 120000
            }
        );

        if (stderr && stderr.trim()) {
            log("ℹ️ vara-wallet:", stderr.trim());
        }

        const raw = stdout.trim();
        let basketId = null;

        try {
            const parsed = JSON.parse(raw);
            basketId = parsed?.result ?? parsed?.ok ?? parsed;
        } catch {
            const match = raw.match(/\d+/g);
            if (match && match.length) {
                basketId = match[match.length - 1];
            }
        }

        if (basketId === null || basketId === undefined || basketId === "") {
            log("❌ Basket creation error: unable to parse basket ID");
            log("📄 Raw output:", raw);
            return null;
        }

        basketId = String(basketId);
        log(`🎯 Basket created with ID: ${basketId}`);
        return basketId;
    } catch (err) {
        const detail =
            err?.stderr?.trim?.() ||
            err?.stdout?.trim?.() ||
            err?.message ||
            String(err);

        log("❌ Basket creation error:", detail);
        return null;
    }
}

async function loop() {
    log("🚀 TURBO LOOP STARTED");

    await init();
    await ensureVoucher();
    await registerAgent();

    while (true) {
        try {
            await ensureVoucher();

            log("🔄 Starting autonomous cycle...");
            const result = await createAutonomousBasket();

            if (result) {
                log(`✅ Created Basket ID: ${result}`);
            }

            log("⏰ Waiting roughly 5 seconds before next creation...");
            await wait(5000); // 5 sec cooldown between creation to avoid overwhelming the node

        } catch (err) {
            log("💥 Loop error:", err.message);
            await wait(5000);
        }
    }
}

async function main() {
    await init();
    await loop();
}

main().catch((err) => {
    console.error("💥 Fatal:", err);
    process.exit(1);
});
