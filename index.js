import { GearApi, decodeAddress } from "@gear-js/api";
import { Keyring } from "@polkadot/keyring";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

console.log("⚡ POLYBASKETS DIRECT VARA SPAMMER STARTING...");

const RPC = "wss://rpc.vara.network";
const BET_TOKEN = "0x186f6cda18fea13d9fc5969eec5a379220d6726f64c1d5f4b346e89271f917bc";
const BET_LANE = "0x35848dea0ab64f283497deaff93b12fe4d17649624b2cd5149f253ef372b29dc";
const VOUCHER_URL = "https://voucher-backend-production-5a1b.up.railway.app/voucher";
const HARDCODED_VOUCHER_ID = "0x6b2ffcc0b5d42a134545d71448768ccb87cbc16b20da124a117d756bbac6c4fe";

let api;
let account;
let hexAddress;
let voucherId;
let txCounter = 0;

function log(...args) {
    console.log(`[${new Date().toLocaleTimeString()}] ⚡`, ...args);
}

function buildApprovePayload(amountBigInt) {
    const service = Buffer.from("BetToken");
    const method = Buffer.from("Approve");
    const spender = Buffer.from(BET_LANE.replace("0x", ""), "hex");
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
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${VOUCHER_URL}/${hexAddress}`, { signal: controller.signal });
        const data = await res.json();
        if (data.voucherId) voucherId = data.voucherId;
        if (data.canTopUpNow === true) {
            log("🔄 Topping up voucher...");
            try {
                const controller2 = new AbortController();
                setTimeout(() => controller2.abort(), 5000);
                const postRes = await fetch(VOUCHER_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ 
                        account: hexAddress, 
                        programs: [
                            "0xe5dd153b813c768b109094a9e2eb496c38216b1dbe868391f1d20ac927b7d2c2",
                            BET_TOKEN, 
                            BET_LANE
                        ] 
                    }),
                    signal: controller2.signal
                });
                const postData = await postRes.json();
                if (postData.voucherId) {
                    voucherId = postData.voucherId;
                    log("✅ Voucher topped up:", voucherId);
                }
            } catch (e) {
                log("⚠️ Top-up failed:", e.message);
            }
        }
    } catch (err) {
        log("⚠️ Voucher backend issue, using hardcoded");
        if (!voucherId) voucherId = HARDCODED_VOUCHER_ID;
    }
}

async function spamApprove(batchSize = 10) {
    try {
        const startingNonce = await api.rpc.system.accountNextIndex(account.address);
        let nonce = startingNonce.toNumber();
        const promises = [];

        for (let i = 0; i < batchSize; i++) {
            const amount = 20000000000000n + BigInt(Math.floor(Math.random() * 999000));
            const payloadHex = buildApprovePayload(amount);

            let tx;
            if (voucherId) {
                // Use voucher if available
                const msgTx = api.message.send({
                    destination: BET_TOKEN,
                    payload: payloadHex,
                    gasLimit: 25000000000,
                    value: 0
                });
                tx = api.voucher.call(voucherId, { SendMessage: msgTx });
            } else {
                // Pay directly from wallet VARA
                tx = api.message.send({
                    destination: BET_TOKEN,
                    payload: payloadHex,
                    gasLimit: 25000000000,
                    value: 0
                });
            }

            const currentNonce = nonce++;
            const txPromise = new Promise((resolve) => {
                tx.signAndSend(account, { nonce: currentNonce }, ({ status }) => {
                    if (status.isReady || status.isBroadcast) {
                        resolve(true);
                    }
                }).catch(() => resolve(false));
            });

            promises.push(txPromise);
            txCounter++;
            log(`✅ TX #${txCounter} | Nonce: ${currentNonce} | ${voucherId ? 'VOUCHER' : 'DIRECT'}`);
        }

        await Promise.all(promises);
        return batchSize;

    } catch (err) {
        log("❌ Batch error:", err.message);
        return 0;
    }
}

async function loop() {
    log("🚀 LOOP STARTED - voucher when available, direct VARA fallback");

    await ensureVoucher();
    setInterval(ensureVoucher, 60_000);

    while (true) {
        try {
            await spamApprove(10);
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
