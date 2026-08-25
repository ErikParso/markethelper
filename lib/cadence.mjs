#!/usr/bin/env node
/**
 * Decide WHEN the next /autotrade run should fire.
 *
 * WHY THIS EXISTS: the loop used to run every 2 hours, which is 12 runs a day. Erik,
 * 2026-08-25: "every 2 hours is burning tokens... lets agent decide and schedule when
 * following loop will execute." Most of those runs re-read a market that had not moved —
 * run 32 fired 18 minutes after run 31 and nothing in the book had moved more than 0.3%.
 *
 * THE SPLIT THIS FILE ENFORCES. Judgement stays with the trader: what the next dated
 * event is, and whether a rung just filled. Arithmetic lives here: how far the nearest
 * resting bid is from the market, the night guard, the clamps, and the cron string. That
 * way the cadence cannot quietly drift into "whatever felt right", and the reasoning is
 * reproducible from the inputs.
 *
 * Usage:
 *   node lib/cadence.mjs
 *   node lib/cadence.mjs '{"next_event_utc":"2026-08-26T12:30:00Z","next_event":"core PCE"}'
 *   node lib/cadence.mjs '{"rung_filled":true}'
 *
 * Input fields (all optional):
 *   next_event_utc   ISO timestamp of the next dated catalyst the sweep found
 *   next_event       what it is, for the printed reason
 *   rung_filled      true if a resting order filled since the last run
 *   thesis_broken    true if a holding's thesis broke and needs follow-up
 *   force_hours      override the computed interval (say why in the run log)
 *
 * Prints the fire time in local and UTC, the 5-field cron for CronCreate
 * (recurring:false), and the reason. Exit 0 always — cadence advice must never be able
 * to take down a trading run.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOUR = 3600e3;

let input = {};
try {
  const raw = process.argv.slice(2).join(" ").trim();
  if (raw) input = JSON.parse(raw);
} catch (e) {
  console.error(`cadence: could not parse input JSON (${e.message}) — continuing with defaults.`);
}

// ---------------------------------------------------------------- book state
function readJSON(p) {
  const f = resolve(ROOT, p);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

const account = readJSON("state/account.json");
const orders = account?.open_orders ?? [];

// Nearest resting bid, as a percentage below the market. This is the main driver: a bid
// about to fill is worth coming back for, because a fill wants re-laddering. A bid miles
// away is not.
async function nearestRungPct() {
  if (!orders.length) return null;
  let tickers;
  try {
    const r = await fetch("https://api.pionex.com/api/v1/market/tickers", {
      signal: AbortSignal.timeout(15000),
    });
    tickers = (await r.json())?.data?.tickers ?? [];
  } catch {
    return null; // network trouble is not a reason to fail; fall through to the default
  }
  const px = {};
  for (const t of tickers) px[t.symbol] = Number(t.close);

  let best = null;
  for (const o of orders) {
    const mkt = px[o.symbol];
    const bid = Number(o.price);
    if (!mkt || !bid) continue;
    const pct = ((mkt - bid) / mkt) * 100;
    if (pct < 0) continue; // above market — it should already have filled
    if (best === null || pct < best.pct) best = { pct, symbol: o.symbol, bid, mkt };
  }
  return best;
}

// ---------------------------------------------------------------- the rules
function decide(rung) {
  // 1. Something just happened that needs following up. Come back quickly, and this
  //    OVERRIDES the night guard — a fill at 02:00 still wants re-laddering at 03:00,
  //    because the level that filled it is exactly the level worth working again.
  if (input.rung_filled) return { hours: 1, urgent: true, why: "a resting order FILLED — come back and re-ladder before the level is gone" };
  if (input.thesis_broken) return { hours: 1, urgent: true, why: "a holding's thesis broke — follow-up cannot wait on a normal cadence" };

  // 2. Otherwise the nearest resting bid sets the pace.
  if (rung) {
    if (rung.pct < 1.0) return { hours: 4, why: `nearest rung ${rung.symbol} is only ${rung.pct.toFixed(2)}% below market — a fill is live` };
    if (rung.pct < 2.5) return { hours: 6, why: `nearest rung ${rung.symbol} is ${rung.pct.toFixed(2)}% below market — reachable but not imminent` };
    return { hours: 9, why: `nearest rung ${rung.symbol} is ${rung.pct.toFixed(2)}% below market — nothing is close` };
  }

  // 4. No orders working at all. That is itself worth a shortish loop, because a book with
  //    no resting bids is not doing what the grid mandate asks of it.
  return { hours: 5, why: "NO resting orders are working — the book is idle between runs, so come back and fix that" };
}

// ---------------------------------------------------------------- guards
// Never fire in the small hours unless an event demands it. A 03:00 run costs tokens and
// finds a market nobody traded. Spot cannot be liquidated, so nothing needs defending
// overnight that a resting order is not already defending.
function nightGuard(when, eventDriven) {
  if (eventDriven) return { when, note: null };
  const h = when.getHours();
  if (h >= 23 || h < 6) {
    const pushed = new Date(when);
    if (h >= 23) pushed.setDate(pushed.getDate() + 1);
    pushed.setHours(6, 50, 0, 0);
    return { when: pushed, note: `pushed out of the ${String(h).padStart(2, "0")}:00 local dead zone to 06:50 local` };
  }
  return { when, note: null };
}

// Avoid :00 and :30 — every scheduler on the planet lands there.
function offMinute(when) {
  const m = when.getMinutes();
  if (m === 0 || m === 30) when.setMinutes(m + 7);
  return when;
}

// ---------------------------------------------------------------- main
const rung = await nearestRungPct();
const d = decide(rung);

const hours = Number(input.force_hours) || d.hours;
let when = new Date(Date.now() + hours * HOUR);
let eventDriven = false;
let eventNote = null;

// A dated event caps how far ahead we may schedule. NEVER step over one: if the
// rule-based time lands after the event, fire 20 minutes AFTER the event instead. If the
// rule-based time is already earlier, keep it — that run will schedule the post-event one
// itself, which is how the chain walks up to a catalyst instead of leaping past it.
if (input.next_event_utc) {
  const t = Date.parse(input.next_event_utc);
  if (!Number.isNaN(t)) {
    const after = new Date(t + 20 * 60e3);
    const label = `${input.next_event || "the next dated event"} (${new Date(t).toISOString().slice(0, 16)}Z)`;
    if (after.getTime() > Date.now() && after.getTime() < when.getTime()) {
      when = after;
      eventDriven = true;
      eventNote = `20 min after ${label} — the event, not the clock, sets this one`;
    } else if (after.getTime() > Date.now()) {
      eventNote = `${label} is further out than this interval; this run will schedule the post-event one`;
    }
  }
}

// Clamp: never sooner than an hour (token burn), never later than twelve (a book with
// open positions and resting orders should not go a working day unlooked-at).
const minT = Date.now() + 1 * HOUR;
const maxT = Date.now() + 12 * HOUR;
let clamp = null;
if (when.getTime() < minT) {
  when = new Date(minT);
  clamp = "clamped UP to the 1h floor";
} else if (when.getTime() > maxT) {
  when = new Date(maxT);
  clamp = "clamped DOWN to the 12h ceiling";
}

const guarded = nightGuard(when, eventDriven || d.urgent);
when = offMinute(guarded.when);

const cron = `${when.getMinutes()} ${when.getHours()} ${when.getDate()} ${when.getMonth() + 1} *`;
const inHours = ((when.getTime() - Date.now()) / HOUR).toFixed(1);

const reasons = [d.why, eventNote, guarded.note, clamp, input.force_hours ? `force_hours=${input.force_hours} override supplied` : null].filter(Boolean);

console.log("NEXT RUN");
console.log(`  local   ${when.toLocaleString()}   (in ${inHours}h)`);
console.log(`  utc     ${when.toISOString().slice(0, 16)}Z`);
console.log(`  cron    "${cron}"      <- CronCreate with recurring:false`);
console.log(`  reason  ${reasons.join("; ")}`);
if (rung) console.log(`  rung    ${rung.symbol} bid ${rung.bid} vs market ${rung.mkt} (${rung.pct.toFixed(2)}% away)`);
else if (orders.length) console.log("  rung    open orders exist but prices could not be fetched — used the default interval");
else console.log("  rung    none working");
