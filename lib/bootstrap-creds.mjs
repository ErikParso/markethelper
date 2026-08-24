#!/usr/bin/env node
/**
 * Write ~/.pionex/config.toml from environment variables when it is missing.
 *
 * WHY THIS EXISTS
 * ---------------
 * Both `pionex-trade-cli` and lib/futures.mjs read credentials from
 * ~/.pionex/config.toml and nowhere else. That is fine on Erik's machine, where the
 * file already exists. It is fatal in a CLOUD run: a scheduled cloud agent gets a
 * fresh sandbox with a git checkout and nothing else, so it has no config file, no
 * credentials, and therefore cannot read the account or place an order. It would
 * run the whole protocol blind and — correctly, per CLAUDE.md — have to create HALT.
 *
 * So: in the cloud, inject PIONEX_API_KEY and PIONEX_API_SECRET as secrets and run
 * this first. It materialises the same config.toml both tools already expect, which
 * means neither of them needs to change.
 *
 * SAFETY
 * ------
 * - NEVER overwrites an existing config.toml. On Erik's machine this is a no-op, so
 *   it is safe to call unconditionally at the top of any run.
 * - Writes with mode 0600.
 * - Never prints the key or secret. Only their lengths, so a truncated secret is
 *   diagnosable without leaking it.
 * - Exits 0 when the file already exists or was written; exits 1 only when the file
 *   is absent AND the env vars are not set, which is the case the caller must treat
 *   as "no credentials, do not trade".
 *
 * Usage:  node lib/bootstrap-creds.mjs [profile]      # default profile: pionx-prod
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";

const PROFILE = process.argv[2] || "pionx-prod";
const CONFIG = resolve(homedir(), ".pionex", "config.toml");

if (existsSync(CONFIG)) {
  console.log(`credentials: ${CONFIG} already exists — left untouched.`);
  process.exit(0);
}

const apiKey = process.env.PIONEX_API_KEY;
const apiSecret = process.env.PIONEX_API_SECRET;

if (!apiKey || !apiSecret) {
  console.error(
    `NO CREDENTIALS. ${CONFIG} does not exist and PIONEX_API_KEY / PIONEX_API_SECRET are not set.\n` +
    `  This run CANNOT read the account or place an order.\n` +
    `  In a cloud routine, add both as environment secrets. Do not proceed with a trading run.`,
  );
  process.exit(1);
}

mkdirSync(dirname(CONFIG), { recursive: true });
writeFileSync(
  CONFIG,
  `default_profile = "${PROFILE}"\n\n` +
  `[profiles.${PROFILE}]\n` +
  `api_key = "${apiKey}"\n` +
  `secret_key = "${apiSecret}"\n` +
  `base_url = "https://api.pionex.com"\n`,
  { mode: 0o600 },
);

console.log(
  `credentials: wrote ${CONFIG} for profile "${PROFILE}" ` +
  `(key ${apiKey.length} chars, secret ${apiSecret.length} chars).`,
);
