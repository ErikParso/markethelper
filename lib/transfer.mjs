#!/usr/bin/env node
/**
 * Move USDT between Erik's spot wallet (MAIN) and futures wallet (TRADE).
 *
 * WHY THIS EXISTS
 * ---------------
 * For the whole life of this project CLAUDE.md claimed "the API key does not carry
 * that permission", so the futures wallet sat empty and every perp was unreachable:
 * 602 contracts, all shorting, all real hedging. The claim was FALSE. It came from
 * noticing that pionex-trade-cli has no transfer command and generalising that into
 * "the API cannot" — the same defect as comparing a fund's share price to a barrel
 * price for ten runs. Erik asked "are you sure you cannot use the API for that?" and
 * the answer, in one search, was no I was not.
 *
 * The cost of that error is the reason the book had only one defensive tool. Going to
 * cash guarantees 0% and, in a rising market, guarantees underperformance. With the
 * futures wallet funded, "defend" can mean hedge instead of retreat.
 *
 *   POST /api/v1/assets/transfer
 *     fromAccount  MAIN (spot) | TRADE (futures)
 *     toAccount    MAIN | TRADE
 *     currency     e.g. USDT
 *     amount       string
 *     clientId     REQUIRED — the API rejects an empty one
 *
 * SCOPE: this moves money between two wallets that both belong to Erik on the same
 * exchange. It is a sizing decision, not a withdrawal. WITHDRAW remains banned and is
 * not reachable from here — there is no destination parameter to abuse.
 *
 * Usage:
 *   node lib/transfer.mjs <amount> <from> <to> [currency]
 *   node lib/transfer.mjs 25 MAIN TRADE
 *   node lib/transfer.mjs 25 TRADE MAIN
 *   node lib/transfer.mjs --check          # balances on both sides, moves nothing
 */
import { randomUUID } from "node:crypto";
import { call } from "./futures.mjs";

const PROFILE = "pionx-prod";
const ACCOUNTS = new Set(["MAIN", "TRADE"]);

async function balances() {
  const fut = await call("GET", "/uapi/v1/account/balances", {}, { profile: PROFILE });
  let spot = null;
  try {
    const w = await call("GET", "/api/v1/account/balances", {}, { profile: PROFILE });
    spot = w?.data?.balances ?? null;
  } catch {
    /* spot is readable via the CLI anyway; not worth failing the whole call */
  }
  return { futures: fut?.data ?? null, spot };
}

const args = process.argv.slice(2);

if (args[0] === "--check" || args.length === 0) {
  const b = await balances();
  console.log("FUTURES (TRADE):", JSON.stringify(b.futures));
  if (b.spot) {
    const u = b.spot.find?.((x) => x.coin === "USDT");
    console.log("SPOT (MAIN) USDT:", u ? u.free : "see `pionex-trade-cli wallet balance_full`");
  }
  console.log("\nnothing moved — pass an amount to transfer, e.g. node lib/transfer.mjs 25 MAIN TRADE");
  process.exit(0);
}

const [amountRaw, from, to, currency = "USDT"] = args;
const amount = Number(amountRaw);

if (!(amount > 0)) {
  console.error(`amount must be a positive number — got ${JSON.stringify(amountRaw)}`);
  process.exit(2);
}
if (!ACCOUNTS.has(from) || !ACCOUNTS.has(to)) {
  console.error(`from/to must each be MAIN or TRADE — got ${from} -> ${to}`);
  process.exit(2);
}
if (from === to) {
  console.error("from and to are the same account; nothing to do");
  process.exit(2);
}

const body = {
  fromAccount: from,
  toAccount: to,
  currency,
  amount: String(amount),
  clientId: randomUUID().replace(/-/g, "").slice(0, 32),
};

const res = await call("POST", "/api/v1/assets/transfer", body, { profile: PROFILE });

if (res?.result === false) {
  console.error(`TRANSFER FAILED  ${res.code ?? ""} ${res.message ?? ""}`.trim());
  process.exit(1);
}

const d = res?.data ?? {};
console.log(`TRANSFERRED ${amount} ${currency}  ${from} -> ${to}`);
console.log(`  transferId ${d.transferId ?? "?"}   status ${d.status ?? "?"}`);
if (d.status === "PROCESSING") console.log("  status is PROCESSING — re-check balances before sizing anything on it.");
console.log("\nBalances after:");
const after = await balances();
console.log("  FUTURES (TRADE):", JSON.stringify(after.futures));
