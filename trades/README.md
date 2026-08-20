# Trade log

`YYYY-MM-DD.json` per day, append-only:

```json
{ "realized_pnl_usdt": 0,
  "orders": [ { "ts": "...", "action": "OPEN_LONG", "symbol": "BTC_USDT",
                "notional_usdt": 400, "confidence": "HIGH", "sources": ["https://..."],
                "reasoning": "...", "falsifier": "...", "result": "filled|rejected",
                "preflight": "APPROVED|<rejection reasons>" } ] }
```

Preflight reads `realized_pnl_usdt` and `orders[]` to enforce the daily loss limit, the daily
order cap, and per-symbol cooldowns. **If this file is wrong, those limits silently stop
working.** Write it every run, before reporting.

Never rewrite history to look smarter. Scoring only means something if the record says what was
actually decided at the time.
