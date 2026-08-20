#!/usr/bin/env node
/**
 * Signed client for Pionex's futures/perpetual API (/uapi/v1/*), which
 * pionex-trade-cli does not wrap. Without this, perps are unreachable — and perps
 * are where the real universe lives: 602 contracts vs 406 spot symbols, including
 * every tokenized equity that has no spot listing (ANTHROPIC, OPENAI, URAX, OKLOX,
 * NVDAX, MSTRX, COINX …).
 *
 * Signing scheme mirrors the official CLI exactly:
 *   payload   = METHOD + path + "?" + sorted(query + timestamp) + bodyJson?
 *   signature = HMAC-SHA256(apiSecret, payload) hex
 *   headers   = PIONEX-KEY, PIONEX-SIGNATURE
 *
 * Credentials are read from ~/.pionex/config.toml — the same file the CLI uses.
 * They are never passed on the command line and never logged.
 *
 * Usage:
 *   node lib/futures.mjs GET  /uapi/v1/trade/openOrders '{"symbol":"BTC_USDT_PERP"}'
 *   node lib/futures.mjs POST /uapi/v1/trade/order '{"symbol":"...","side":"BUY",...}'
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const CONFIG = resolve(homedir(), ".pionex", "config.toml");

function loadCreds(profile) {
  const raw = readFileSync(CONFIG, "utf8");
  // Minimal TOML read — this file only ever holds a default_profile and
  // [profiles.<name>] tables, so a full parser would be dead weight.
  const want = profile ?? (raw.match(/^default_profile\s*=\s*"([^"]+)"/m)?.[1] ?? "default");
  const section = raw.split(/^\[profiles\./m).find((s) => s.startsWith(want + "]"));
  if (!section) throw new Error(`profile "${want}" not found in ${CONFIG}`);
  const get = (k) => section.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
  const apiKey = get("api_key"), apiSecret = get("secret_key");
  if (!apiKey || !apiSecret) throw new Error(`profile "${want}" is missing api_key/secret_key`);
  return { apiKey, apiSecret, baseUrl: get("base_url") || "https://api.pionex.com" };
}

/**
 * Git Bash (MSYS) rewrites a leading "/uapi/..." argument into a Windows path such as
 * "C:/Program Files/Git/uapi/...". That silently produces a garbage URL and an ENOTFOUND
 * that looks like a network fault. Recover the real API path rather than requiring every
 * caller to remember MSYS_NO_PATHCONV=1.
 */
function normalizePath(path) {
  const m = path.match(/\/(uapi|api)\/v\d.*/);
  if (!m) throw new Error(`path must contain /uapi/vN or /api/vN — got ${JSON.stringify(path)}`);
  return m[0];
}

export async function call(method, rawPath, params = {}, { profile } = {}) {
  const path = normalizePath(rawPath);
  const { apiKey, apiSecret, baseUrl } = loadCreds(profile);

  // POST/DELETE carry their parameters in the JSON body; GET puts them in the query.
  const hasBody = method === "POST" || method === "DELETE";
  const query = hasBody ? {} : params;
  const bodyJson = hasBody ? JSON.stringify(params) : null;

  const signed = { ...query, timestamp: Date.now().toString() };
  const queryString = Object.keys(signed).sort().map((k) => `${k}=${signed[k]}`).join("&");
  const pathUrl = `${path}?${queryString}`;

  let payload = `${method}${pathUrl}`;
  if (bodyJson != null) payload += bodyJson;
  const signature = crypto.createHmac("sha256", apiSecret).update(payload).digest("hex");

  if (process.env.PIONEX_DEBUG) console.error("DEBUG url:", JSON.stringify(`${baseUrl}${pathUrl}`));

  const res = await fetch(`${baseUrl}${pathUrl}`, {
    method,
    headers: {
      "PIONEX-KEY": apiKey,
      "PIONEX-SIGNATURE": signature,
      "Content-Type": "application/json",
    },
    body: bodyJson ?? undefined,
    signal: AbortSignal.timeout(20000),
  });

  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { result: false, httpStatus: res.status, raw: text.slice(0, 400) }; }
}

// CLI entry — only when run directly, so the module stays importable.
if (process.argv[1]?.endsWith("futures.mjs")) {
  const [, , method = "GET", path, json] = process.argv;
  if (!path) {
    console.error("usage: node lib/futures.mjs <GET|POST|DELETE> <path> ['<json params>']");
    process.exit(2);
  }
  let params = {};
  if (json) {
    try { params = JSON.parse(json); }
    catch { console.error("params must be valid JSON"); process.exit(2); }
  }
  call(method.toUpperCase(), path, params)
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r?.result === false ? 1 : 0); })
    .catch((e) => {
      console.error("ERROR:", e.name, "|", e.message, "| cause:", e.cause?.code || e.cause?.message || "(none)");
      process.exit(1);
    });
}
