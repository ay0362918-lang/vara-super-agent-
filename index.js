import { GearApi, decodeAddress } from "@gear-js/api";
import { Keyring } from "@polkadot/keyring";
import { u8aToHex } from "@polkadot/util";
import { setTimeout as wait } from "timers/promises";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

console.log("🔥 POLYBASKETS SEASON 2 AGENT V3 STARTING...");

// --- CONFIG ---
const RPC = "wss://rpc.vara.network";
const BASKET_MARKET = "0xe5dd153b813c768b109094a9e2eb496c38216b1dbe868391f1d20ac927b7d2c2";
const BET_TOKEN = "0x186f6cda18fea13d9fc5969eec5a379220d6726f64c1d5f4b346e89271f917bc";
const BET_LANE = "0x35848dea0ab64f283497deaff93b12fe4d17649624b2cd5149f253ef372b29dc";

const VOUCHER_URL = "https://voucher-backend-production-5a1b.up.railway.app/voucher";
const BET_QUOTE_URL = "https://bet-quote-service-production.up.railway.app/api/bet-lane/quote";
const POLYMARKET_API = "https://gamma-api.polymarket.com/markets";

const BET_AMOUNT = "10000000000000"; // 10 CHIP
const AGENT_NAME = process.env.AGENT_NAME || "hy4";

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
  hexAddress = u8aToHex(decodeAddress(account.address));

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
    if (!voucherId) return;
    try {
        log("📝 Registering agent name on-chain...");
        const payload = { RegisterAgent: [AGENT_NAME] };

        const tx = await api.message.send({
            destination: BASKET_MARKET,
            payload,
            gasLimit: 2_000_000_000,
            prepaidVoucher: voucherId
        });

        await new Promise((resolve, reject) => {
            tx.signAndSend(account, ({ status }) => {
                if (status.isInBlock) log("📥 Registration in block");
                if (status.isFinalized) {
                    log("✅ Registration finalized");
                    resolve();
                }
            });
        });

    } catch (err) {
        log("ℹ️ Registration note:", err.message);
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
            log("❌ Claim error: bet_token_client.idl not found");
            log("ℹ️ Looked in:", idlCandidates.join(" | "));
            return false;
        }

        if (!process.env.PRIVATE_KEY) {
            log("❌ Claim error: PRIVATE_KEY missing");
            return false;
        }

        const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
            ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
            : ["--seed", process.env.PRIVATE_KEY.trim()];

        log("🪙 Claiming hourly CHIP...");

        await execFileAsync("vara-wallet", ["config", "set", "network", "mainnet"], {
            maxBuffer: 1024 * 1024
        });

        const { stdout, stderr } = await execFileAsync(
            "vara-wallet",
            [
                ...signerArgs,
                "call",
                BET_TOKEN,
                "BetToken/Claim",
                "--args",
                "[]",
                "--voucher",
                voucherId,
                "--idl",
                idlPath
            ],
            {
                maxBuffer: 1024 * 1024 * 4
            }
        );

        if (stderr && stderr.trim()) {
            log("ℹ️ vara-wallet:", stderr.trim());
        }

        const raw = stdout.trim();
        let parsed = null;

        try {
            parsed = JSON.parse(raw);
        } catch {
            log("❌ Claim error: unable to parse claim response");
            log("📄 Raw claim output:", raw);
            return false;
        }

        // Only log success if the contract result is actually successful
        const result = parsed?.result;

        if (result === false) {
            log("ℹ️ Claim not available or failed:", raw);
            return false;
        }

        log("✅ CHIP Claimed");
        if (raw) {
            log("📄 Claim response:", raw);
        }
        return true;
    } catch (err) {
        const detail =
            err?.stderr?.trim?.() ||
            err?.stdout?.trim?.() ||
            err?.message ||
            String(err);

        if (detail.includes("ClaimTooEarly")) {
            log("ℹ️ Claim not available yet");
            return false;
        }

        log("❌ Claim error:", detail);
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

            const basketName = `Auto-${AGENT_NAME}-${Math.random().toString(36).substring(2, 7)}`.slice(0, 128);
            const description = "Autonomous basket created by Season 2 Agent".slice(0, 512);
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
                log("ℹ️ Looked in:", idlCandidates.join(" | "));
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
                maxBuffer: 1024 * 1024
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
                    "--idl",
                    idlPath
                ],
                {
                    maxBuffer: 1024 * 1024 * 4
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



    async function getQuote(basketId) {
        try {
            log("📊 Getting quote for:", basketId);

            const numericBasketId = Number(basketId);
            if (!Number.isFinite(numericBasketId)) {
                throw new Error(`Invalid numeric basketId: ${basketId}`);
            }

            // Small delay so backend/indexer can see the newly created basket
            await wait(2000);

            const body = {
                user: hexAddress,
                basketId: numericBasketId,
                amount: BET_AMOUNT,
                targetProgramId: BET_LANE,
            };

            const res = await fetch(BET_QUOTE_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            const data = await res.json();

            if (!res.ok || !data || data.error) {
                throw new Error(data?.error || `HTTP ${res.status}`);
            }

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
      log("ℹ️ Looked in:", idlCandidates.join(" | "));
      return false;
    }

    if (!process.env.PRIVATE_KEY) {
      log("❌ Approve error: PRIVATE_KEY missing");
      return false;
    }

    const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
      ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
      : ["--seed", process.env.PRIVATE_KEY.trim()];

    const normalizedAmount = String(amount).trim();
    if (!/^\d+$/.test(normalizedAmount)) {
      log("❌ Approve error: invalid amount format");
      return false;
    }

    await execFileAsync("vara-wallet", ["config", "set", "network", "mainnet"], {
      maxBuffer: 1024 * 1024
    });

    const runApprove = async (rawAmount, label) => {
      const argsJson = `["${BET_LANE}", ${rawAmount}]`;

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
          "--idl",
          idlPath
        ],
        {
          maxBuffer: 1024 * 1024 * 4
        }
      );

      if (stderr && stderr.trim()) {
        log(`ℹ️ vara-wallet (${label}):`, stderr.trim());
      }

      const raw = stdout.trim();
      let parsed = null;

      try {
        parsed = JSON.parse(raw);
      } catch {
        log(`❌ Approve error: unable to parse ${label} response`);
        log("📄 Raw approve output:", raw);
        return false;
      }

      log(`📄 Approve ${label} response:`, raw);
      return parsed?.result === true;
    };

    log("✅ Resetting CHIP allowance to 0...");
    const resetOk = await runApprove("0", "reset");

    if (resetOk) {
      log("✅ Allowance reset successful");
    } else {
      log("ℹ️ Allowance reset returned false, continuing anyway");
    }

    await wait(1500);

    log("✅ Approving CHIP for BetLane...");
    const approveOk = await runApprove(normalizedAmount, "final");

    if (!approveOk) {
      log("❌ Approval failed: result was not true");
      return false;
    }

    log("✅ Approval successful");
    await wait(1500);
    return true;
  } catch (err) {
    const detail =
      err?.stderr?.trim?.() ||
      err?.stdout?.trim?.() ||
      err?.message ||
      String(err);

    log("❌ Approve error:", detail);
    return false;
  }
}


    async function placeBet(basketId, quote) {
        if (!voucherId) return;

        try {
            const approved = await approveBetLane(BET_AMOUNT);
            if (!approved) {
                log("⚠️ Skipping bet because approval did not succeed");
                return;
            }

            const { promisify } = await import("node:util");
            const { execFile } = await import("node:child_process");
            const { existsSync } = await import("node:fs");
            const { join } = await import("node:path");

            const execFileAsync = promisify(execFile);
            const home = process.env.HOME || process.env.USERPROFILE || "";

            const idlCandidates = [
                process.env.BET_LANE_IDL,
                process.env.POLYBASKETS_SKILLS_DIR
                    ? join(process.env.POLYBASKETS_SKILLS_DIR, "idl", "bet_lane_client.idl")
                    : null,
                join(process.cwd(), "skills", "idl", "bet_lane_client.idl"),
                join(home, ".agents", "skills", "polybaskets-skills", "idl", "bet_lane_client.idl")
            ].filter(Boolean);

            const idlPath = idlCandidates.find((p) => existsSync(p));

            if (!idlPath) {
                log("❌ Bet error: bet_lane_client.idl not found");
                log("ℹ️ Looked in:", idlCandidates.join(" | "));
                return;
            }

            if (!process.env.PRIVATE_KEY) {
                log("❌ Bet error: PRIVATE_KEY missing");
                return;
            }

            const signerArgs = process.env.PRIVATE_KEY.trim().includes(" ")
                ? ["--mnemonic", process.env.PRIVATE_KEY.trim()]
                : ["--seed", process.env.PRIVATE_KEY.trim()];

            log("💰 Placing bet on:", basketId);

            const argsJson = JSON.stringify([
                Number(basketId),
                BET_AMOUNT,
                quote
            ]);

            await execFileAsync("vara-wallet", ["config", "set", "network", "mainnet"], {
                maxBuffer: 1024 * 1024
            });

            const { stdout, stderr } = await execFileAsync(
                "vara-wallet",
                [
                    ...signerArgs,
                    "call",
                    BET_LANE,
                    "BetLane/PlaceBet",
                    "--args",
                    argsJson,
                    "--voucher",
                    voucherId,
                    "--idl",
                    idlPath
                ],
                {
                    maxBuffer: 1024 * 1024 * 4
                }
            );

            if (stderr && stderr.trim()) {
                log("ℹ️ vara-wallet:", stderr.trim());
            }

            log("✅ Bet placed successfully");
            if (stdout && stdout.trim()) {
                log("📄 Bet response:", stdout.trim());
            }
        } catch (err) {
            const detail =
                err?.stderr?.trim?.() ||
                err?.stdout?.trim?.() ||
                err?.message ||
                String(err);

            log("❌ Bet error:", detail);
        }
    }



    async function loop() {
        log("🚀 LOOP STARTED");

        await init();
        await ensureVoucher();
        await registerAgent();
        await claimCHIP();

        while (true) {
            try {
                await ensureVoucher();
                await claimCHIP();

                log("🔄 Starting autonomous cycle...");

                const result = await createAutonomousBasket();

                if (result) {
                    let basketId = typeof result === 'string' ? result : null;

                    if (basketId) {
                        log(`🎯 Target Basket ID: ${basketId}`);
                        const quote = await getQuote(basketId);
                        if (quote) {
                            await placeBet(basketId, quote);
                        }
                    } else {
                        log("⚠️ Basket created but ID not captured from events. Skipping bet this round.");
                    }
                }

                log("😴 Waiting for next round...");
                await wait(60000);

            } catch (err) {
                log("💥 Loop error:", err.message);
                await wait(10000);
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
