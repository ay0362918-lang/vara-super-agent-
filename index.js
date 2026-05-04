import { GearApi, decodeAddress } from "@gear-js/api";
import { Keyring } from "@polkadot/keyring";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

console.log("⚡ POLYBASKETS ULTRA-FAST SPAMMER (V2) STARTING...");

const RPC = "wss://rpc.vara.network";
const BASKET_MARKET = "0xe5dd153b813c768b109094a9e2eb496c38216b1dbe868391f1d20ac927b7d2c2";
const BET_TOKEN = "0x186f6cda18fea13d9fc5969eec5a379220d6726f64c1d5f4b346e89271f917bc";
const BET_LANE = "0x35848dea0ab64f283497deaff93b12fe4d17649624b2cd5149f253ef372b29dc";

const VOUCHER_URL = "https://voucher-backend-production-5a1b.up.railway.app/voucher";
const HARDCODED_VOUCHER_ID = "0x25fc1e90bcfad1417c646d0f9d1cc40b9b7ec6d367cb223d0f42171007397506";

let api;
let account;
let hexAddress;
let voucherId;
let txCounter = 0;

function log(...args) {
    console.log(`[${new Date().toLocaleTimeString()}] ⚡`, ...args);
}

// Exactly mirrors the Rust payload logic to avoid double SCALE encoding WASM traps!
function buildApprovePayload(amountBigInt) {
    const service = Buffer.from("BetToken");
    const method = Buffer.from("Approve");
    const spender = Buffer.from(BET_LANE.replace("0x", ""), "hex");
    
    // Convert 256-bit amount to little endian bytes
    const amountBuffer = Buffer.alloc(32);
    amountBuffer.writeBigUInt64LE(amountBigInt & 0xFFFFFFFFFFFFFFFFn, 0);
    amountBuffer.writeBigUInt64LE(amountBigInt >> 64n, 8);

    const payload = Buffer.concat([
        Buffer.from([(service.length) << 2]),
        service,
        Buffer.from([(method.length) << 2]),
        method,
        spender,
        amountBuffer
    ]);

    return "0x" + payload.toString("hex");
}

async function init() {
    log("🔌 Connecting to Vara WebSocket...");
    api = await GearApi.create({ providerAddress: RPC });

    const keyring = new Keyring({ type: "sr25519" });
    if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY missing in .env");
    account = keyring.addFromUri(process.env.PRIVATE_KEY);
    hexAddress = decodeAddress(account.address);

    log("✅ Connected:", account.address);
    log("📍 Hex address:", hexAddress);
}

async function ensureVoucher() {
    try {
        const res = await fetch(`${VOUCHER_URL}/${hexAddress}`);
        const data = await res.json();
        if (data.voucherId) {
            voucherId = data.voucherId;
            return;
        }
    } catch (err) {
        log("⚠️ Voucher backend down, using hardcoded voucher");
    }
    // Fallback to hardcoded
    voucherId = HARDCODED_VOUCHER_ID;
    log("🎫 Using hardcoded voucher:", voucherId);
}

        const postRes = await fetch(VOUCHER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ account: hexAddress, programs: [BASKET_MARKET, BET_TOKEN, BET_LANE] })
        });

        const postData = await postRes.json();
        if (postData.voucherId) voucherId = postData.voucherId;
        else if (data.voucherId) voucherId = data.voucherId;
        
        log("🎫 Voucher:", voucherId);
    } catch (err) {
        log("⚠️ Voucher error:", err.message);
    }
}

async function spamApproveDirectAPI(batchSize = 10) {
    if (!voucherId) return 0;
    log("🎫 Using voucher:", voucherId);

    try {
        // Fetch nonce ONCE
        const startingNonce = await api.rpc.system.accountNextIndex(account.address);
        let nonce = startingNonce.toNumber();

        const promises = [];

        for (let i = 0; i < batchSize; i++) {
            const amount = 20000000000000n + BigInt(Math.floor(Math.random() * 999000));
            const payloadHex = buildApprovePayload(amount);

            // Construct raw Gear message extrinsic
            const message = {
                destination: BET_TOKEN,
                payload: payloadHex,
                gasLimit: 25000000000,
                value: 0
            };

            // Wrap the message extrinsic in a voucher call
            const msgTx = api.message.send(message);
            const tx = api.voucher.call(voucherId, { SendMessage: msgTx });

            const currentNonce = nonce++;

            // Sign and submit, but DO NOT await block inclusion
            const txPromise = new Promise((resolve) => {
                tx.signAndSend(account, { nonce: currentNonce }, ({ status, events }) => {
                    if (status.isReady || status.isBroadcast) {
                        // Immediately resolve once it hits the mempool
                        resolve(true);
                    }
                }).catch(err => {
                    resolve(false);
                });
            });

            promises.push(txPromise);
            
            txCounter++;
            log(`✅ TX #${txCounter} | Nonce pipelined: ${currentNonce}`);
        }

        // Wait for all txs in batch to reach mempool
        await Promise.all(promises);
        return batchSize;

    } catch (err) {
        log("❌ Batch error:", err.message);
        return 0;
    }
}

async function loop() {
    log("🚀 ULTRA-FAST NONCE-PIPELINING LOOP STARTED");
    
    await ensureVoucher();
    setInterval(ensureVoucher, 60_000);

    let round = 0;
    while (true) {
        try {
            round++;
            await spamApproveDirectAPI(10); // Fire 10 transactions per batch
            // Chain block time naturally throttles us slightly, but mempool accepts them instantly
            await new Promise(r => setTimeout(r, 2000)); 
        } catch (err) {
            log("💥 Loop error:", err.message);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

async function main() {
    await init();
    await loop();
}

main().catch(err => {
    console.error("💥 Fatal:", err);
    process.exit(1);
});
