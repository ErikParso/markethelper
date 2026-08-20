#!/usr/bin/env node
/**
 * Pass-2 coverage record.
 *
 * The run protocol says to sweep every watchlist theme before deploying capital.
 * That instruction lived only in CLAUDE.md, which means it was advisory — on
 * 2026-08-20 run 4 it got skipped under time pressure: a semiconductor thread was
 * researched, found real, and then silently dropped without ever being ranked
 * against the book. The result was a 86%-of-equity concentration reached without
 * testing the alternatives.
 *
 * So the sweep now leaves a written artefact, and preflight refuses to open or add
 * without it. "Looked, found nothing" is a perfectly good answer — it just has to be
 * typed out per theme, which cannot be done without actually looking.
 *
 * Themes are read from watchlist.json rather than hardcoded, so adding a theme there
 * automatically widens required coverage.
 *
 * Usage:
 *   node lib/coverage.mjs init     # scaffold state/coverage.json with every theme blank
 *   node lib/coverage.mjs check    # validate; exit 0 = complete, 1 = incomplete
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s) => resolve(ROOT, ...s);

export const COVERAGE = p("state", "coverage.json");
export const VERDICTS = ["PASS", "CANDIDATE", "TRADED"];
const MIN_FINDING = 25; // long enough that "n/a" and "nothing" cannot pass

/** Theme keys come from the watchlist so the two can never drift apart. */
export function requiredThemes() {
  const w = JSON.parse(readFileSync(p("watchlist.json"), "utf8"));
  return Object.keys(w.tradeable ?? {});
}

/**
 * Validate the coverage file. Returns { ok, problems[] } rather than throwing, so
 * preflight can fold the problems into its own rejection list.
 */
export function checkCoverage(maxAgeMin = 90) {
  const problems = [];
  if (!existsSync(COVERAGE)) {
    return { ok: false, problems: ["state/coverage.json missing — run `node lib/coverage.mjs init` and fill it in."] };
  }

  let cov;
  try { cov = JSON.parse(readFileSync(COVERAGE, "utf8")); }
  catch { return { ok: false, problems: ["state/coverage.json is not valid JSON."] }; }

  const age = (Date.now() - new Date(cov.as_of).getTime()) / 60000;
  if (!Number.isFinite(age)) problems.push("coverage.json has an unparseable as_of timestamp.");
  else if (age > maxAgeMin) problems.push(`coverage.json is ${Math.round(age)}min stale (limit ${maxAgeMin}min) — re-sweep, do not just touch the timestamp.`);
  else if (age < -2) problems.push("coverage.json is timestamped in the future.");

  const themes = cov.themes ?? {};
  for (const key of requiredThemes()) {
    const t = themes[key];
    if (!t) { problems.push(`theme "${key}" not covered.`); continue; }
    const finding = String(t.finding ?? "").trim();
    if (finding.length < MIN_FINDING) problems.push(`theme "${key}": finding is empty or too short to be a real answer.`);
    if (!VERDICTS.includes(t.verdict)) problems.push(`theme "${key}": verdict must be one of ${VERDICTS.join("|")}.`);
  }

  const wide = String(cov.wide_sweep ?? "").trim();
  if (wide.length < MIN_FINDING) problems.push("wide_sweep is empty — the watchlist is a floor on coverage, not a ceiling.");

  return { ok: problems.length === 0, problems };
}

// ---- CLI ---------------------------------------------------------------
// Only when run directly. Without this guard the block below would execute on
// import and read preflight's order JSON as its own subcommand.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const cmd = isMain ? process.argv[2] : undefined;

if (cmd === "init") {
  mkdirSync(p("state"), { recursive: true });
  if (existsSync(COVERAGE)) {
    // Never clobber a sweep already in progress.
    console.error("state/coverage.json already exists. Delete it first if you really want a blank one.");
    process.exit(2);
  }
  const themes = Object.fromEntries(
    requiredThemes().map((k) => [k, { finding: "", verdict: "", tickers_considered: [] }]),
  );
  writeFileSync(COVERAGE, JSON.stringify({
    as_of: new Date().toISOString(),
    _howto: `One line per theme: what has actually happened there since the last run, and a verdict. ` +
            `PASS = looked, nothing worth trading. CANDIDATE = worth ranking against the book. TRADED = acted on. ` +
            `"PASS" is a fine answer; it just has to be written after looking. Findings under ${MIN_FINDING} chars are rejected.`,
    themes,
    wide_sweep: "",
  }, null, 2));
  console.log(`scaffolded ${COVERAGE} with ${Object.keys(themes).length} themes — fill in every finding + verdict.`);
  process.exit(0);
}

if (cmd === "check") {
  const { ok, problems } = checkCoverage();
  if (ok) { console.log("COVERAGE COMPLETE — all themes swept."); process.exit(0); }
  console.log("COVERAGE INCOMPLETE\n  - " + problems.join("\n  - "));
  process.exit(1);
}

if (cmd) { console.error(`unknown command "${cmd}" — expected init|check`); process.exit(2); }
