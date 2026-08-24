#!/usr/bin/env node
/**
 * Send the end-of-run summary to WhatsApp.
 *
 * WHY: Erik runs /autotrade on a 2-hour loop and wants one line per run — what was
 * done and why — on WhatsApp rather than only in a terminal he is not watching.
 * Claude Code's own PushNotification reaches the terminal (and his phone via Remote
 * Control) but cannot reach WhatsApp, so this fills that gap.
 *
 * TRANSPORTS, tried in order. The first one whose env vars are set wins.
 *
 *   1. CallMeBot  — simplest for personal use, no account, one API key.
 *        CALLMEBOT_APIKEY   the key the bot sends back to you
 *        WHATSAPP_PHONE     your number in full international form, e.g. +421900123456
 *
 *   2. Twilio     — proper API, better for anything long-lived.
 *        TWILIO_ACCOUNT_SID
 *        TWILIO_AUTH_TOKEN
 *        TWILIO_WHATSAPP_FROM   e.g. whatsapp:+14155238886  (sandbox number)
 *        WHATSAPP_PHONE         your number, e.g. +421900123456
 *
 * Usage:
 *   node lib/notify.mjs "Bought 12 ETH on ETF inflows; resting bid 2380. Equity 152.1"
 *   echo "..." | node lib/notify.mjs
 *
 * Exit codes: 0 sent, 2 no transport configured (prints the message so the run log
 * still carries it), 1 the transport was configured but the send failed.
 *
 * NEVER put keys in this file or in the repo — they come from the environment.
 */

// Load .env if present, without adding a dotenv dependency. .env is gitignored, so
// this is where the phone number and API key live — they must never reach the repo,
// which is public. Real environment variables always win over the file.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/^["']|["']$/g, "");
    if (val && process.env[key] === undefined) process.env[key] = val;
  }
}

const msg = (process.argv.slice(2).join(" ") || "").trim();

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.trim();
}

const text = msg || (await readStdin());
if (!text) {
  console.error('usage: node lib/notify.mjs "message"   (or pipe it on stdin)');
  process.exit(2);
}

// WhatsApp truncates long pushes on some clients and the summary should be one
// glanceable line anyway. Keep it tight rather than letting it sprawl.
const body = text.length > 900 ? text.slice(0, 897) + "..." : text;
const phone = process.env.WHATSAPP_PHONE;

async function viaCallMeBot() {
  const key = process.env.CALLMEBOT_APIKEY;
  if (!key || !phone) return false;
  const url =
    "https://api.callmebot.com/whatsapp.php" +
    `?phone=${encodeURIComponent(phone)}` +
    `&text=${encodeURIComponent(body)}` +
    `&apikey=${encodeURIComponent(key)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const out = await r.text();
  if (!r.ok) throw new Error(`CallMeBot HTTP ${r.status}: ${out.slice(0, 200)}`);
  console.log("whatsapp: sent via CallMeBot.");
  return true;
}

async function viaTelegram() {
  // Not WhatsApp, but it is free, has no capacity limit, and takes about two
  // minutes to set up. Added 2026-08-24 after CallMeBot turned out to be full.
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: body, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20000),
  });
  const out = await r.text();
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}: ${out.slice(0, 300)}`);
  console.log("notify: sent via Telegram.");
  return true;
}

async function viaTwilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from || !phone) return false;
  const to = phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
    signal: AbortSignal.timeout(20000),
  });
  const out = await r.text();
  if (!r.ok) throw new Error(`Twilio HTTP ${r.status}: ${out.slice(0, 300)}`);
  console.log("whatsapp: sent via Twilio.");
  return true;
}

try {
  // WhatsApp transports first — that is what Erik asked for. Telegram is the
  // fallback only because every WhatsApp route needs an account he must create.
  if (await viaTwilio()) process.exit(0);
  if (await viaCallMeBot()) process.exit(0);
  if (await viaTelegram()) process.exit(0);
} catch (e) {
  // A failed notification must never take down a trading run.
  console.error(`whatsapp: SEND FAILED — ${e.message}`);
  console.error(`  message was: ${body}`);
  process.exit(1);
}

console.error(
  "whatsapp: no transport configured — set CALLMEBOT_APIKEY + WHATSAPP_PHONE, " +
  "or the four TWILIO_* vars. Message follows so the run log still has it:",
);
console.log(body);
process.exit(2);
