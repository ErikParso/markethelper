# markethelper

An autonomous trading agent for [Pionex](https://www.pionex.com), driven by Claude Code.
It reads the account, hunts news, forms theses, and places real orders — spot crypto,
tokenized equities/ETFs/commodities, and perpetuals.

**This trades real money with no notional or leverage caps by default.** Read
[CLAUDE.md](CLAUDE.md) and [policy.json](policy.json) before running it against a funded
account.

## Setup

```bash
npm i -g @pionex/pionex-ai-kit
pionex-trade-cli --help
```

Create an API key in the Pionex app, then write `~/.pionex/config.toml`
(`C:\Users\<you>\.pionex\config.toml` on Windows):

```toml
default_profile = "pionx-prod"

[profiles.pionx-prod]
api_key    = "<your key>"
secret_key = "<your secret>"
base_url   = "https://api.pionex.com"
```

Both the CLI and [lib/futures.mjs](lib/futures.mjs) read that file — **no credentials
live in this repo**. Restrict the file to your own user (`icacls` on Windows,
`chmod 600` elsewhere) and IP-whitelist the key.

Key permissions: reading + bot reading for research; add trading + bot trading to let the
agent actually place orders. **Never enable Transfer or Withdraw** — moving money off the
exchange is outside the mandate, and the code assumes the key cannot do it.

Verify:

```bash
pionex-trade-cli --read-only wallet balance_full
```

## Running

`/autotrade` in Claude Code runs the two-pass protocol in [CLAUDE.md](CLAUDE.md):
defend open positions, then deploy free capital. `/signal` is a read-only
hold/trim/close review. `/autotrade --score` grades the record against buy-and-hold.

Every order goes through `node lib/preflight.mjs '<json>'`, the single choke point that
honours the kill switch and writes the audit log.

## Kill switch

```bash
touch HALT     # blocks every order, in every mode
```

`HALT` is gitignored and only you should delete it.

## What is not in this repo

Your own trading record is deliberately untracked — it is personal and irrelevant to
anyone cloning this:

| Path | Holds |
|---|---|
| `theses.md` | Open positions, entries, sizing, falsifiers |
| `trades/YYYY-MM-DD.json` | Fills, notionals, realized PnL |
| `decisions/YYYY-MM-DD.md` | Run-by-run decision journal |
| `state/` | Live balances snapshot |
| `HALT`, `.env` | Local operator state and secrets |

The agent creates all of these on its first run. The format is documented in
[trades/README.md](trades/README.md) and [decisions/README.md](decisions/README.md).
