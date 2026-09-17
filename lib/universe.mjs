#!/usr/bin/env node
/**
 * Scan the WHOLE tradeable universe: every spot pair and every perp contract.
 *
 * WHY THIS EXISTS
 * ---------------
 * For a month the hunt covered ~18 tokenized spot names plus BTC and ETH, out of 406
 * spot pairs and 610 perps. One idea a week is a throughput problem, not a judgement
 * problem. The old scanner also claimed perp movers were undetectable because it read
 * the index feed; `/api/v1/market/tickers?type=PERP` carries 24h open/close for all of
 * them. And it never looked at funding at all — the one source of income here that
 * does not depend on being right about direction.
 *
 * Four sections:
 *   MOVERS     spot and perp, |24h| >= threshold on real volume. Hunt these for a cause.
 *   FUNDING    crowded perps: positive funding pays shorts, negative pays longs.
 *   CARRY      symbols with BOTH a spot and a perp leg, so funding can be collected
 *              delta-neutral (long spot + short perp). Basis and weekend risk shown.
 *   CORE       BTC and ETH for reference.
 *
 * Writes state/universe.json. Pure public endpoints — no credentials, no orders.
 *
 * Usage: node lib/universe.mjs [--move 6] [--vol 300000]
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.pionex.com";
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const MOVE = arg("--move", 6); // % 24h
const VOL = arg("--vol", 300000); // USDT 24h, filters out illiquid noise
const CARRY_MIN_FUNDING = 0.0001; // 0.01% per period
const PERIODS_PER_DAY = 3; // 8h funding

const j = (u) => fetch(API + u, { signal: AbortSignal.timeout(20000) }).then((r) => r.json());

const [spotT, perpT, perpI, spotSyms, perpSyms] = await Promise.all([
  j("/api/v1/market/tickers"),
  j("/api/v1/market/tickers?type=PERP"),
  j("/api/v1/market/indexes"),
  j("/api/v1/common/symbols?type=SPOT"),
  j("/api/v1/common/symbols?type=PERP"),
]);

const pct = (t) => (Number(t.open) ? ((Number(t.close) - Number(t.open)) / Number(t.open)) * 100 : 0);
const row = (t, kind) => ({
  symbol: t.symbol,
  base: t.symbol.replace(/_USDT(_PERP)?$/, ""),
  kind,
  price: Number(t.close),
  change24h: +pct(t).toFixed(2),
  volume24hUsdt: Math.round(Number(t.amount ?? 0)),
});

const spot = (spotT?.data?.tickers ?? []).map((t) => row(t, "spot"));
const perp = (perpT?.data?.tickers ?? []).map((t) => row(t, "perp"));
const idx = Object.fromEntries((perpI?.data?.indexes ?? []).map((r) => [r.symbol, r]));
const spotSpec = Object.fromEntries((spotSyms?.data?.symbols ?? []).map((s) => [s.symbol, s]));
const perpSpec = Object.fromEntries((perpSyms?.data?.symbols ?? []).map((s) => [s.symbol, s]));

for (const p of perp) {
  const i = idx[p.symbol];
  p.funding = i ? Number(i.nextFundingRate) : null;
  p.fundingYr = p.funding != null ? +(p.funding * PERIODS_PER_DAY * 365 * 100).toFixed(1) : null;
  p.mark = i ? Number(i.markPrice) : null;
  p.status = perpSpec[p.symbol]?.status ?? "?";
}

// Tokenized equities/ETFs halt when the US market is shut (USOX, 2026-09-12). The spot
// symbol spec has no status field to warn of it, so flag by shape and by weekday.
const isTokenized = (base) => /^[A-Z]{2,6}X$/.test(base) && !["XX", "PAXG", "IMX", "STX", "ZRX", "CVX", "MINAX"].includes(base);
const now = new Date();
const weekend = [0, 6].includes(now.getUTCDay());

const movers = [...spot, ...perp]
  .filter((r) => r.volume24hUsdt >= VOL && Math.abs(r.change24h) >= MOVE)
  .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));

const liquidPerps = perp.filter((p) => p.volume24hUsdt >= VOL && p.funding != null && p.status === "TRADING");
const payShorts = [...liquidPerps].filter((p) => p.funding > 0).sort((a, b) => b.funding - a.funding);
const payLongs = [...liquidPerps].filter((p) => p.funding < 0).sort((a, b) => a.funding - b.funding);

const spotByBase = Object.fromEntries(spot.map((s) => [s.base, s]));
const carry = liquidPerps
  .filter((p) => p.funding >= CARRY_MIN_FUNDING && spotByBase[p.base] && spotSpec[`${p.base}_USDT`]?.enable)
  .map((p) => {
    const s = spotByBase[p.base];
    return {
      base: p.base,
      funding: p.funding,
      fundingYr: p.fundingYr,
      spotPrice: s.price,
      perpMark: p.mark,
      basisPct: +(((p.mark - s.price) / s.price) * 100).toFixed(3),
      spotVolume: s.volume24hUsdt,
      perpVolume: p.volume24hUsdt,
      spotMinOrder: Number(spotSpec[`${p.base}_USDT`]?.minAmount ?? 10),
      tokenized: isTokenized(p.base),
    };
  })
  .sort((a, b) => b.funding - a.funding);

const core = ["BTC", "ETH"].map((b) => ({ spot: spotByBase[b], perp: perp.find((p) => p.base === b) }));

const out = {
  as_of: now.toISOString(),
  weekend_utc: weekend,
  counts: { spot: spot.length, perp: perp.length },
  thresholds: { move_pct: MOVE, min_volume_usdt: VOL },
  movers,
  funding: { pay_shorts: payShorts.slice(0, 15), pay_longs: payLongs.slice(0, 10) },
  carry,
  core,
};
writeFileSync(resolve(ROOT, "state/universe.json"), JSON.stringify(out, null, 2));

// ---- report --------------------------------------------------------------
const f = (x, w) => String(x).padStart(w);
const fp = (x) => `${x > 0 ? "+" : ""}${x}%`;
console.log(`UNIVERSE ${out.as_of}  spot ${spot.length} · perp ${perp.length}${weekend ? "  ⚠ WEEKEND — tokenized spot is halted" : ""}`);

console.log(`\nMOVERS  |24h| >= ${MOVE}% on >= ${(VOL / 1000).toFixed(0)}k volume  (${movers.length})`);
for (const m of movers.slice(0, 15)) {
  console.log(`  ${m.base.padEnd(10)} ${m.kind.padEnd(4)} ${f(fp(m.change24h), 8)}  ${f((m.volume24hUsdt / 1e6).toFixed(2) + "M", 8)}`);
}

console.log(`\nFUNDING — shorts paid (longs crowded), liquid only`);
for (const p of payShorts.slice(0, 8)) {
  console.log(`  ${p.base.padEnd(10)} ${f((p.funding * 100).toFixed(4) + "%", 9)}/8h  ${f(p.fundingYr + "%/yr", 10)}  vol ${(p.volume24hUsdt / 1e6).toFixed(2)}M`);
}
console.log(`FUNDING — longs paid (shorts crowded), liquid only`);
for (const p of payLongs.slice(0, 5)) {
  console.log(`  ${p.base.padEnd(10)} ${f((p.funding * 100).toFixed(4) + "%", 9)}/8h  ${f(p.fundingYr + "%/yr", 10)}  vol ${(p.volume24hUsdt / 1e6).toFixed(2)}M`);
}

console.log(`\nCARRY — spot AND perp both tradeable, funding >= ${(CARRY_MIN_FUNDING * 100).toFixed(2)}%/8h`);
console.log(`  (long spot + short perp at 1x = direction-neutral; you collect funding)`);
for (const c of carry.slice(0, 10)) {
  const warn = c.tokenized ? "  ⚠ tokenized: spot leg halts weekends" : "";
  console.log(`  ${c.base.padEnd(8)} ${f(c.fundingYr + "%/yr", 10)}  basis ${f(fp(c.basisPct), 8)}  spot vol ${f((c.spotVolume / 1000).toFixed(0) + "k", 7)}  perp vol ${(c.perpVolume / 1e6).toFixed(2)}M${warn}`);
}
if (!carry.length) console.log("  none above threshold");

console.log(`\nCORE`);
for (const c of core) {
  if (!c.spot) continue;
  console.log(`  ${c.spot.base.padEnd(5)} ${f(c.spot.price, 11)}  ${f(fp(c.spot.change24h), 8)}  perp funding ${c.perp?.funding != null ? (c.perp.funding * 100).toFixed(4) + "%" : "?"}`);
}
console.log(`\nwrote state/universe.json`);
