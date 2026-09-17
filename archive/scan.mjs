#!/usr/bin/env node
/**
 * Full watchlist price scan. Required every run by lib/coverage.mjs, which refuses
 * to let preflight approve a buy until symbols_scanned covers the whole watchlist.
 *
 * Exists because runs 6-9 (2026-08-21) price-checked only the ~20 names already under
 * consideration, so a name nobody was thinking about could have moved 10% unseen.
 * These are API calls, not searches - the whole scan costs seconds.
 *
 * Usage:  node lib/scan.mjs [out.json]
 *
 * KNOWN LIMITATION: the index feed returns a LEVEL for perps, not a 24h change, so
 * perp movers cannot be detected from one scan - they need comparing against levels
 * recorded in a previous run. Spot movers are detectable; perp movers are not.
 */
import fs from "node:fs";

const w = JSON.parse(fs.readFileSync("watchlist.json", "utf8"));
const spot = new Set(), perp = new Set();
for (const theme of Object.values(w.tradeable ?? {})) {
  for (const s of theme.spot ?? []) spot.add(String(s).replace(/_USDT$/, ""));
  for (const s of theme.perp_only ?? []) perp.add(String(s).replace(/_USDT(_PERP)?$/, ""));
}

// Spot tickers, one request each.
const rows = [];
for (const base of [...spot]) {
  const sym = `${base}_USDT`;
  try {
    const r = await fetch(`https://api.pionex.com/api/v1/market/tickers?symbol=${sym}`);
    const j = await r.json();
    const t = j?.data?.tickers?.[0];
    if (!t) { rows.push({ sym, kind: "SPOT", err: "no data" }); continue; }
    const o = +t.open, c = +t.close;
    rows.push({ sym, kind: "SPOT", close: c, chg: ((c - o) / o) * 100 });
  } catch (e) { rows.push({ sym, kind: "SPOT", err: String(e.message) }); }
}

// Perp indexes, one bulk request.
const ir = await fetch("https://api.pionex.com/api/v1/market/indexes");
const ij = await ir.json();
const idx = {};
for (const x of (ij?.data?.indexes ?? ij?.data ?? [])) idx[x.symbol] = x;
for (const base of [...perp]) {
  const sym = `${base}_USDT_PERP`;
  const x = idx[sym];
  rows.push(x ? { sym, kind: "PERP", close: +x.indexPrice } : { sym, kind: "PERP", err: "not listed" });
}

rows.sort((a, b) => Math.abs(b.chg ?? 0) - Math.abs(a.chg ?? 0));
const scanned = rows.filter(r => !r.err).length;
console.log(`SCANNED ${scanned} / ${rows.length} (spot ${spot.size}, perp ${perp.size})\n`);
console.log("-- movers (spot, |24h| >= 2%) --");
for (const r of rows) if (r.kind === "SPOT" && Math.abs(r.chg ?? 0) >= 2) console.log(`  ${r.sym.padEnd(14)} ${String(r.close).padStart(11)}  ${r.chg > 0 ? "+" : ""}${r.chg.toFixed(2)}%`);
console.log("\n-- quiet spot (|24h| < 2%) --");
for (const r of rows) if (r.kind === "SPOT" && Math.abs(r.chg ?? 0) < 2) console.log(`  ${r.sym.padEnd(14)} ${String(r.close).padStart(11)}  ${r.chg > 0 ? "+" : ""}${r.chg.toFixed(2)}%`);
console.log("\n-- perp index levels --");
for (const r of rows) if (r.kind === "PERP") console.log(`  ${r.sym.padEnd(22)} ${r.err ?? r.close}`);
console.log("\n-- errors --");
for (const r of rows) if (r.err) console.log(`  ${r.sym.padEnd(22)} ${r.err}`);
fs.writeFileSync(process.argv[2] ?? "scan.json", JSON.stringify({ scanned, total: rows.length, rows }, null, 2));
