#!/usr/bin/env node
/**
 * Order gate. Every order goes through here — not to constrain the trader, but so
 * there is exactly one place where the kill switch is honoured and one place where
 * orders are recorded before they hit the exchange.
 *
 * Any limit set to null in policy.json is skipped entirely. In unrestricted mode
 * nearly all of them are null, so this mostly waves orders through. Putting a number
 * back re-arms that check on the next run — no code change needed.
 *
 * Usage:  node lib/preflight.mjs '<order-json>'
 * Order:  { "action":"OPEN_LONG|OPEN_SHORT|CLOSE|REDUCE|ADD|BOT_*", "symbol":"BTC_USDT",
 *           "notional_usdt":123.45, "leverage":3, "confidence":"HIGH",
 *           "stop_loss_pct":5, "sources":["https://..."] }
 *
 * Exit 0 = APPROVED. Exit 1 = REJECTED (reasons on stdout). Exit 2 = misuse.
 */
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCoverage } from "./coverage.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s) => resolve(ROOT, ...s);
const readJSON = (f, fb) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fb);
const usd = (n) => `${Number(n).toFixed(2)} USDT`;
const set = (v) => v !== null && v !== undefined; // null means "no limit"

const RANK = { LOW: 0, MED: 1, HIGH: 2 };
const reject = [];
const fail = (m) => reject.push(m);
const done = () => {
  console.log("REJECTED\n  - " + reject.join("\n  - "));
  process.exit(1);
};

// ---- 1. Kill switch. Checked first, unconditionally, never disabled. ----
// This is Erik's brake, not a policy limit. It stays armed in every mode.
if (existsSync(p("HALT"))) {
  console.log("REJECTED\n  - HALT file present. Delete it to resume trading.");
  process.exit(1);
}

const policy = readJSON(p("policy.json"), null);
if (!policy) { console.error("policy.json missing"); process.exit(2); }

if (policy.enabled !== true) {
  console.log("REJECTED\n  - policy.enabled is false. Autotrading is off.");
  process.exit(1);
}

// ---- 2. Parse the proposed order. --------------------------------------
let order;
try { order = JSON.parse(process.argv[2] ?? ""); }
catch { console.error("usage: node lib/preflight.mjs '<order-json>'"); process.exit(2); }

const {
  action, symbol, notional_usdt, leverage = 1,
  confidence = null, stop_loss_pct = null, sources = [],
} = order;

const opening = ["OPEN_LONG", "OPEN_SHORT", "ADD"].includes(action);

// ---- 3. Actions. Deny always wins over allow. ---------------------------
if (policy.actions.denied.includes(action)) fail(`action ${action} is explicitly denied.`);
if (!policy.actions.allowed.includes(action)) fail(`action ${action} is not a recognised action.`);

// ---- 4. Symbols. mode "any" skips the allowlist entirely. ---------------
if (policy.symbols.mode === "allowlist" && !policy.symbols.allowed.includes(symbol)) {
  fail(`symbol ${symbol} is not on the allowlist (${policy.symbols.allowed.length} entries).`);
}

// ---- 5. Confidence, only if a floor is configured. ----------------------
const need = ["CLOSE", "REDUCE"].includes(action)
  ? policy.confidence.min_to_close
  : action === "ADD" ? policy.confidence.min_to_add : policy.confidence.min_to_open;
if (set(need)) {
  if (!(confidence in RANK)) fail(`confidence "${confidence}" is not LOW|MED|HIGH.`);
  else if (RANK[confidence] < RANK[need]) fail(`confidence ${confidence} < required ${need} for ${action}.`);
}

// ---- 6. Sizing sanity and the exchange floor. ---------------------------
if (!(notional_usdt > 0)) fail("notional_usdt must be a positive number.");

const minNotional = policy.capital.min_notional_usdt ?? 0;
if (notional_usdt > 0 && notional_usdt < minNotional)
  fail(`notional ${usd(notional_usdt)} is below the exchange minimum ${usd(minNotional)}.`);

if (set(policy.risk.max_leverage) && leverage > policy.risk.max_leverage)
  fail(`leverage ${leverage}x exceeds cap ${policy.risk.max_leverage}x.`);

if (opening && policy.risk.require_resting_stop === true) {
  if (!set(stop_loss_pct)) fail("require_resting_stop: order has no stop_loss_pct.");
  else if (!(stop_loss_pct > 0)) fail("stop_loss_pct must be a positive number.");
}

// ---- 7. Live account state. -------------------------------------------
// Sizing against a stale or missing balance is a correctness bug, not a risk
// preference, so this check stays on regardless of mode.
const st = readJSON(p("state", "account.json"), null);
if (!st) {
  fail("state/account.json missing. Refusing to size an order against unknown equity.");
  done();
}

const age = (Date.now() - new Date(st.as_of).getTime()) / 60000;
if (!Number.isFinite(age)) fail("state/account.json has an unparseable as_of timestamp.");
else if (age > 15) fail(`state/account.json is ${Math.round(age)}min stale. Refetch before trading.`);
else if (age < -2) fail("state/account.json is timestamped in the future. Refusing to trade on it.");

const equity = st.equity_usdt;
if (!(equity > 0)) fail("equity_usdt missing or non-positive.");
if (reject.length) done();

// ---- 8. Percentage caps, each skipped when null. -----------------------
const pct = (x) => (equity * x) / 100;

let capOrder = Infinity;
if (set(policy.capital.max_notional_per_order_pct)) capOrder = pct(policy.capital.max_notional_per_order_pct);
if (set(policy.capital.absolute_max_notional_per_order_usdt))
  capOrder = Math.min(capOrder, policy.capital.absolute_max_notional_per_order_usdt);
if (notional_usdt > capOrder) fail(`notional ${usd(notional_usdt)} exceeds per-order cap ${usd(capOrder)}.`);

// A cap that cannot clear the exchange floor blocks everything — say so plainly.
if (Number.isFinite(capOrder) && capOrder < minNotional && set(policy.capital.max_notional_per_order_pct)) {
  const needed = (minNotional * 100) / policy.capital.max_notional_per_order_pct;
  fail(`equity ${usd(equity)} too small: per-order cap ${usd(capOrder)} < exchange minimum ` +
       `${usd(minNotional)}. Fund to ~${usd(needed)} or raise max_notional_per_order_pct.`);
}

if (opening) {
  if (set(policy.capital.max_notional_per_symbol_pct)) {
    const symExp = (st.exposure_by_symbol?.[symbol] ?? 0) + notional_usdt;
    const cap = pct(policy.capital.max_notional_per_symbol_pct);
    if (symExp > cap) fail(`${symbol} exposure would reach ${usd(symExp)}, cap ${usd(cap)}.`);
  }
  if (set(policy.capital.max_total_exposure_pct)) {
    const total = (st.total_exposure_usdt ?? 0) + notional_usdt;
    const cap = pct(policy.capital.max_total_exposure_pct);
    if (total > cap) fail(`total exposure would reach ${usd(total)}, cap ${usd(cap)}.`);
  }
  if (set(policy.capital.min_cash_reserve_pct)) {
    const left = (st.cash_usdt ?? 0) - notional_usdt;
    const floor = pct(policy.capital.min_cash_reserve_pct);
    if (left < floor) fail(`order leaves ${usd(left)} cash, below floor ${usd(floor)}.`);
  }
  if (set(policy.risk.max_open_positions)) {
    const isNew = !(symbol in (st.exposure_by_symbol ?? {}));
    if (isNew && (st.open_position_count ?? 0) >= policy.risk.max_open_positions)
      fail(`already at max_open_positions (${policy.risk.max_open_positions}).`);
  }
}

if (set(policy.risk.max_drawdown_pct_from_peak)) {
  const peak = st.peak_equity_usdt ?? equity;
  if (peak > 0) {
    const dd = ((peak - equity) / peak) * 100;
    if (dd >= policy.risk.max_drawdown_pct_from_peak)
      fail(`drawdown ${dd.toFixed(1)}% >= limit ${policy.risk.max_drawdown_pct_from_peak}%.`);
  }
}

// ---- 8b. Pass-2 coverage, required before deploying capital. -----------
// Deliberately gates OPENS AND ADDS ONLY. Defending the book must never wait on
// research being written up — a position that needs closing gets closed whether or
// not the sweep is done, so CLOSE and REDUCE skip this entirely.
//
// This exists because run 4 (2026-08-20) skipped the wide sweep and reached 86%
// single-thesis concentration without ranking it against the alternatives it had
// already found. Erik owns the switch: policy.research.require_coverage_for_opens.
const research = policy.research ?? {};
if (opening && research.require_coverage_for_opens !== false) {
  const { ok, problems } = checkCoverage(research.coverage_max_age_min ?? 90);
  if (!ok) {
    fail(`pass-2 coverage incomplete — cannot deploy capital without sweeping the watchlist:`);
    for (const pr of problems) fail(`    ${pr}`);
  }
}

// ---- 9. Today's activity, from the append-only log. ---------------------
const today = new Date().toISOString().slice(0, 10);
const log = readJSON(p("trades", `${today}.json`), { orders: [], realized_pnl_usdt: 0 });

if (set(policy.risk.max_orders_per_day) && log.orders.length >= policy.risk.max_orders_per_day)
  fail(`daily order limit ${policy.risk.max_orders_per_day} reached.`);

if (set(policy.risk.max_daily_realized_loss_pct)) {
  const cap = pct(policy.risk.max_daily_realized_loss_pct);
  if (log.realized_pnl_usdt <= -cap)
    fail(`daily loss limit hit (${usd(log.realized_pnl_usdt)} vs ${usd(-cap)}).`);
}

const cool = policy.cooldowns.min_minutes_between_orders_same_symbol ?? 0;
if (cool > 0) {
  const last = log.orders.filter((o) => o.symbol === symbol).at(-1);
  if (last) {
    const mins = (Date.now() - new Date(last.ts).getTime()) / 60000;
    if (mins < cool) fail(`cooldown: ${Math.round(cool - mins)}min left on ${symbol}.`);
  }
}

// ---- verdict ------------------------------------------------------------
if (reject.length) done();

// Append an approval receipt BEFORE printing APPROVED, so the record cannot be
// skipped by an agent that reads the exit code and moves straight to the order.
//
// This exists because nothing previously PROVED an order had been gated. Preflight
// printed "Log this order..." and then trusted the trader to do it — and the trader
// writes its own trade log, so the audit trail was entirely self-reported. With this
// receipt, lib/protocol-audit.mjs can reconcile real exchange fills against real
// approvals and catch an order that bypassed the gate or was never logged.
try {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    action, symbol,
    notional_usdt: Number(notional_usdt),
    leverage, confidence,
    stop_loss_pct: stop_loss_pct ?? null,
    sources: Array.isArray(sources) ? sources.length : 0,
    equity_at_approval: Number(equity),
    mode: policy.mode ?? "limited",
  });
  appendFileSync(p("state", "preflight-log.jsonl"), line + "\n");
} catch (e) {
  // A receipt that cannot be written is an audit hole, so this is fatal rather
  // than best-effort: fail closed, do not approve an order we cannot account for.
  console.log(`REJECTED\n  - could not write the preflight receipt (${e.message}). Refusing to approve an unauditable order.`);
  process.exit(1);
}

console.log(
  `APPROVED  ${action} ${symbol} ${usd(notional_usdt)} @ ${leverage}x` +
  (confidence ? ` (${confidence})` : "") +
  (set(stop_loss_pct) ? `  stop -${stop_loss_pct}%` : "  NO STOP") +
  `\n  mode=${policy.mode ?? "limited"} | equity ${usd(equity)}` +
  `\n  Log this order to trades/${today}.json before or immediately after placing it.`,
);
process.exit(0);
