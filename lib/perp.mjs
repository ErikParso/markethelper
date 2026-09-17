#!/usr/bin/env node
/**
 * Perpetual futures helper — the only way this project places perp orders.
 *
 * WHY THIS EXISTS
 * ---------------
 * This account DEFAULTS TO 5x LEVERAGE IN CROSS MARGIN (read back 2026-09-17 on
 * CRCLX_USDT_PERP). A perp order placed through the raw client would have opened a 5x
 * position backed by the whole futures wallet. The trading rules allow 1x only, because
 * Pionex has no stop or take-profit orders anywhere and the book is looked at once a
 * day. So every order here first forces ISOLATED margin and 1x leverage, reads both
 * back, and refuses to trade unless the read-back confirms it.
 *
 * Usage:
 *   node lib/perp.mjs specs  SYMBOL
 *   node lib/perp.mjs safe   SYMBOL                  # force ISOLATED + 1x, verify
 *   node lib/perp.mjs order  '{"symbol":"CRCLX_USDT_PERP","side":"SELL","size":0.4}'
 *   node lib/perp.mjs order  '{"symbol":"...","side":"BUY","size":0.4,"reduceOnly":true}'
 *   node lib/perp.mjs order  '{"symbol":"...","side":"BUY","size":0.4,"price":80.5}'   # limit
 *   node lib/perp.mjs positions
 *   node lib/perp.mjs orders [SYMBOL]
 *   node lib/perp.mjs cancel SYMBOL ORDER_ID
 *
 * `order` does NOT run preflight — callers (carry.mjs, or a human-issued command) must
 * run `node lib/preflight.mjs` first. It does enforce the leverage rule itself, because
 * that one is not allowed to depend on anyone remembering.
 */
import { call } from "./futures.mjs";

export const MAX_LEVERAGE = 1;
const PROFILE = "pionx-prod";
const API = "https://api.pionex.com";

const get = (path, params = {}) => call("GET", path, params, { profile: PROFILE });
const post = (path, body) => call("POST", path, body, { profile: PROFILE });

const toSymbol = (s) => (s.endsWith("_PERP") ? s : `${s.replace(/_USDT$/, "")}_USDT_PERP`);

export async function specs(symbol) {
  const sym = toSymbol(symbol);
  const r = await fetch(`${API}/api/v1/common/symbols?symbols=${sym}`).then((x) => x.json());
  const s = r?.data?.symbols?.[0];
  if (!s) throw new Error(`no perp contract ${sym}`);
  return s;
}

export async function market(symbol) {
  const sym = toSymbol(symbol);
  const [t, i] = await Promise.all([
    fetch(`${API}/api/v1/market/tickers?symbol=${sym}`).then((x) => x.json()),
    fetch(`${API}/api/v1/market/indexes?symbol=${sym}`).then((x) => x.json()),
  ]);
  const tk = t?.data?.tickers?.[0];
  const ix = i?.data?.indexes?.[0];
  if (!tk || !ix) throw new Error(`no market data for ${sym}`);
  return {
    symbol: sym,
    last: Number(tk.close),
    mark: Number(ix.markPrice),
    index: Number(ix.indexPrice),
    funding: Number(ix.nextFundingRate),
    nextFundingTime: Number(ix.nextFundingTime),
    volume24hUsdt: Number(tk.amount),
    trades24h: Number(tk.count),
  };
}

/** Force ISOLATED margin and 1x leverage, then prove it by reading both back. */
export async function ensureSafe(symbol) {
  const sym = toSymbol(symbol);
  const mode = await get("/uapi/v1/trade/isolatedMode", { symbol: sym });
  if (mode?.data?.isolatedMode !== "ISOLATED") {
    const r = await post("/uapi/v1/trade/isolatedMode", { symbol: sym, isolatedMode: "ISOLATED" });
    if (r?.result === false) throw new Error(`could not set ISOLATED on ${sym}: ${r.code} ${r.message}`);
  }
  const lev = await get("/uapi/v1/account/leverage", { symbol: sym });
  const cur = Number(lev?.data?.leverages?.[0]?.leverage);
  if (cur !== MAX_LEVERAGE) {
    const r = await post("/uapi/v1/account/leverage", { symbol: sym, leverage: String(MAX_LEVERAGE) });
    if (r?.result === false) throw new Error(`could not set ${MAX_LEVERAGE}x on ${sym}: ${r.code} ${r.message}`);
  }
  // Read back — a successful POST is not proof.
  const [m2, l2] = await Promise.all([
    get("/uapi/v1/trade/isolatedMode", { symbol: sym }),
    get("/uapi/v1/account/leverage", { symbol: sym }),
  ]);
  const okMode = m2?.data?.isolatedMode === "ISOLATED";
  const okLev = Number(l2?.data?.leverages?.[0]?.leverage) === MAX_LEVERAGE;
  if (!okMode || !okLev) {
    throw new Error(`${sym} NOT SAFE after update: mode=${m2?.data?.isolatedMode} leverage=${l2?.data?.leverages?.[0]?.leverage}`);
  }
  return { symbol: sym, isolatedMode: "ISOLATED", leverage: MAX_LEVERAGE };
}

/** Round DOWN to the contract step so an order is never larger than intended. */
export function roundStep(size, step) {
  const dp = Math.max(0, (String(step).split(".")[1] ?? "").length);
  const n = Math.floor(Number(size) / Number(step) + 1e-9) * Number(step);
  return Number(n.toFixed(dp));
}

export async function order({ symbol, side, size, price, reduceOnly = false, clientOrderId }) {
  const sym = toSymbol(symbol);
  if (!["BUY", "SELL"].includes(side)) throw new Error(`side must be BUY or SELL, got ${side}`);
  const sp = await specs(sym);
  if (sp.status !== "TRADING") throw new Error(`${sym} status is ${sp.status}, not TRADING`);

  const qty = roundStep(size, sp.baseStep);
  const px = price != null ? Number(price) : (await market(sym)).mark;
  if (!(qty > 0)) throw new Error(`size ${size} rounds to 0 at step ${sp.baseStep}`);
  if (qty * px < Number(sp.minNotional)) throw new Error(`notional ${(qty * px).toFixed(2)} below minNotional ${sp.minNotional}`);

  // The leverage rule is enforced here, not trusted to the caller. Reduce-only orders
  // can only shrink risk, so they skip it (a stuck setting must never block an exit).
  if (!reduceOnly) await ensureSafe(sym);

  const body = { symbol: sym, side, size: String(qty) };
  if (price != null) {
    body.type = "LIMIT";
    body.price = String(Number(price).toFixed(Number(sp.quotePrecision)));
  } else {
    body.type = "MARKET_QTY";
  }
  if (reduceOnly) body.reduceOnly = true;
  if (clientOrderId) body.clientOrderId = clientOrderId;

  const r = await post("/uapi/v1/trade/order", body);
  if (r?.result === false) throw new Error(`order rejected: ${r.code} ${r.message}`);
  return { request: body, response: r?.data ?? r };
}

export async function positions() {
  const r = await get("/uapi/v1/account/positions");
  return (r?.data?.positions ?? []).filter((p) => Number(p.netSize) !== 0);
}

export async function balances() {
  const r = await get("/uapi/v1/account/balances");
  return r?.data ?? { balances: [], isolates: [] };
}

export async function openOrders(symbol) {
  const params = symbol ? { symbol: toSymbol(symbol) } : {};
  const r = await get("/uapi/v1/trade/openOrders", params);
  return r?.data?.orders ?? [];
}

export async function cancel(symbol, orderId) {
  const r = await call("DELETE", "/uapi/v1/trade/order", { symbol: toSymbol(symbol), orderId: Number(orderId) }, { profile: PROFILE });
  if (r?.result === false) throw new Error(`cancel rejected: ${r.code} ${r.message}`);
  return r?.data ?? r;
}

// ---- CLI -----------------------------------------------------------------
if (process.argv[1]?.endsWith("perp.mjs")) {
  const [, , cmd, a, b] = process.argv;
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  const run = {
    specs: () => specs(a).then(out),
    market: () => market(a).then(out),
    safe: () => ensureSafe(a).then(out),
    order: () => order(JSON.parse(a)).then(out),
    positions: () => positions().then(out),
    balances: () => balances().then(out),
    orders: () => openOrders(a).then(out),
    cancel: () => cancel(a, b).then(out),
  }[cmd];
  if (!run) {
    console.error("usage: node lib/perp.mjs <specs|market|safe|order|positions|balances|orders|cancel> ...");
    process.exit(2);
  }
  run().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
