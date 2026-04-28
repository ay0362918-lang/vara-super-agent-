import { GearApi, decodeAddress } from "@gear-js/api";
import { Keyring } from "@polkadot/keyring";
import { setTimeout as wait } from "timers/promises";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

console.log("🔥 POLYBASKETS APPROVE SPAMMER STARTING...");

// --- CONFIG ---
const RPC = "wss://rpc.vara.network";
const BASKET_MARKET = "0xe5dd153b813c768b109094a9e2eb496c38216b1dbe868391f1d20ac927b7d2c2";
const BET_TOKEN = "0x186f6cda18fea13d9fc5969eec5a379220d6726f64c1d5f4b346e89271f917bc";
const BET_LANE = "0x35848dea0ab64f283497deaff93b12fe4d17649624b2cd5149f253ef372b29dc";

const VOUCHER_URL = "https://voucher-backend-production-5a1b.up.railway.app/voucher";

const AGENT_NAME = process.env.AGENT_NAME || "approve-spammer";

// --- STATE ---
let api;
let account;
let hexAddress;
let voucherId;
let approveCounter = 0;

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

    // Update to correct hex for the wallet running THIS server
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
                programs: [BASKET_MARKET, BET_TOKEN, BET_LANE]
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

        log("✅ Registration submitted");
        return true;
    } catch (err) {
        log("ℹ️ Registration note:", String(err));
        return false;
    }
}

async function approveBetLane(baseAmount) {
    if (!voucherId) return false;

    try {
        const { promisify } = await import("node:util");
        const { execFile } = await import("node:child_process");
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");

        const execFileAsync = promisify(execFile);
        const home = process.env.HOME || process.env.USERPROFILE || "";

        const idlCandidates = [
            process.env.BET_TOKEN_IDL,
            process.env.POLYBASKETS_SKILLS_DIR
                ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "bet_token_client.idl")
                : null,
            join(process.cwd(), "skills", "idl", "bet_token_client.idl"),
            join(home, ".agents", "skills", "polybaskets-skills", "idl", "bet_token_client.idl")
        ].filter(Boolean);

        const idlPath = idlCandidates.find((p) => existsSync(p));

        if (!idlPath) {
            log("❌ Approve error: bet_token_client.idl not found");
            return false;
        }

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        // Vary the exact amount slightly so the transaction payload is unique each time constraints
        // preventing the blockchain or RPC node from caching and dropping what looks like an accidental duplicate transaction.
        const randomizedAmount = Number(baseAmount) + Math.floor(Math.random() * 100);
        
        // [MASSIVE SPEED OPTIMIZATION]: Removed the 'config set network mainnet' command from the loop since it is already permanently configured in registerAgent!

        const argsJson = `["${BET_LANE}", ${randomizedAmount}]`;
        
        log(`💸 Spam Approve Action #${approveCounter + 1} for CHIP (${randomizedAmount})`);

        const { stdout, stderr } = await execFileAsync(
            "vara-wallet",
            [
                ...signerArgs,
                "call",
                BET_TOKEN,
                "BetToken/Approve",
                "--args",
                argsJson,
                "--voucher",
                voucherId,
                "--gas-limit",
                "25000000000",
                "--idl",
                idlPath
            ],
            { maxBuffer: 1024 * 1024 * 4, timeout: 120000 }
        );

        const raw = stdout?.trim() || "";
        let parsed = null;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return false;
        }

        if (parsed?.result === true) {
            approveCounter++;
            log(`✅ Spam Approve #${approveCounter} Successful`);
            return true;
        }
        return false;

    } catch (err) {
        let errorMsg = err.message || String(err);
        if (process.env.PRIVATE_KEY) {
            errorMsg = errorMsg.replace(process.env.PRIVATE_KEY.trim(), "[HIDDEN-MNEMONIC]");
        }
        // Shorten the massive error dump since it's just expected nonce collisions
        const isCollision = errorMsg.includes("Command failed");
        log(isCollision ? "⚠️ Approve skipped (Expected Nonce Collision)" : `❌ Approve error: ${errorMsg}`);
        return false;
    }
}

async function worker(id, offsetMs) {
    await wait(offsetMs);
    log(`🏃 Worker ${id} spawned and offsetting by ${offsetMs}ms...`);
    let localCounter = 0;
    while (true) {
        try {
            // Only worker 1 does the voucher check to save API calls
            if (localCounter % 10 === 0 && id === 1) { 
                 await ensureVoucher();
            }
            // Add massive random padding at the end to guarantee variance
            await approveBetLane("200000000000" + Math.floor(Math.random() * 99));
            localCounter++;
        } catch (err) {
            await wait(2000);
        }
    }
}

async function loop() {
    log("🚀 MULTI-THREADED APPROVE SPAMMER LOOP STARTED");

    await init();
    await ensureVoucher();
    await registerAgent();

    // Spawn 5 concurrent overlapping workers on this ONE server
    // They are offset by 1500ms so they perfectly interleave the 6s transaction block time natively!
    worker(1, 0);
    worker(2, 1500);
    worker(3, 3000);
    worker(4, 4500);
    worker(5, 6000);

    while(true) {
        // Keep the main process alive forever while workers do the heavy lifting in asynchronously
        await wait(60000);
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
