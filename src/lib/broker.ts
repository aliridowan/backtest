// Simulated broker. The chart shows bid prices; ask = bid + spread.
// Buys open at the ask and close at the bid, sells the other way round.
// Orders are checked against every 1-minute candle; when a stop and a target
// fall inside the same minute the stop wins (the cautious guess).

import { contractSize, defaultSpread, defaultSwap, isIndex, marginUsd, maxLeverage, pipSize, pnlUsd, pointSize } from "./instruments";
import { nyDst, type Bar } from "./market";
import type { Account, CloseReason, Session, Trade } from "./types";

type AccountType = { marginCall: number; stopOut: number; commission: number; prop?: Pick<Account, "leverage" | "levCaps" | "cryptoPct" | "maxLots" | "raw" | "commFree"> };
// Exness account types: margin call / stop out levels and the usual commission.
// FundingPips (MT5): $5 per lot round turn on forex and gold ($7 on Zero),
// 0.04% on crypto, raw spreads, 1:100 forex (1:50 Zero), gold 1:30 / 1:10 / 1:20,
// crypto 1:2 in the evaluation, oil 1:10 and no commission on it, at most 20
// lots per order. Their margin call / stop out levels aren't published; 100% /
// 50% is the usual MT5 setting.
export const ACCOUNT_TYPES: Record<string, AccountType> = {
  Standard: { marginCall: 60, stopOut: 0, commission: 0 },
  Pro: { marginCall: 30, stopOut: 0, commission: 0 },
  "Raw Spread": { marginCall: 30, stopOut: 0, commission: 7 },
  Zero: { marginCall: 30, stopOut: 0, commission: 7 },
  "FundingPips 2-Step": { marginCall: 100, stopOut: 50, commission: 5, prop: { leverage: 100, levCaps: { XAUUSD: 30, BTCUSD: 2, USOIL: 10, US30: 20, NAS100: 20 }, cryptoPct: 0.04, maxLots: 20, raw: true, commFree: ["USOIL", "US30", "NAS100"] } },
  "FundingPips 1-Step": { marginCall: 100, stopOut: 50, commission: 5, prop: { leverage: 100, levCaps: { XAUUSD: 10, BTCUSD: 2, USOIL: 10, US30: 5, NAS100: 5 }, cryptoPct: 0.04, maxLots: 20, raw: true, commFree: ["USOIL", "US30", "NAS100"] } },
  "FundingPips Zero": { marginCall: 100, stopOut: 50, commission: 7, prop: { leverage: 50, levCaps: { XAUUSD: 20, BTCUSD: 2, USOIL: 10, US30: 20, NAS100: 20 }, cryptoPct: 0.04, maxLots: 20, raw: true, commFree: ["USOIL", "US30", "NAS100"] } },
};
export const LEVERAGES = [2, 10, 20, 30, 50, 100, 200, 400, 500, 600, 800, 1000, 2000];
const ACCOUNT_DEFAULT: Account = { type: "Standard", leverage: 500, marginCall: 60, stopOut: 0, swaps: true, floatingSpread: true, swapPts: {}, levCaps: {}, cryptoPct: null, maxLots: null, raw: false, commFree: [] };
export function acct(s: Session): Account {
  const a = { ...ACCOUNT_DEFAULT, ...s.account }, p = ACCOUNT_TYPES[a.type]?.prop;
  // Symbols added after the session was made (US30, NAS100) get its type's limits.
  return p ? { ...a, levCaps: { ...p.levCaps, ...a.levCaps }, commFree: [...new Set([...(p.commFree ?? []), ...a.commFree])] } : a;
}
// The account settings an account type brings (Exness types clear the FundingPips limits).
export function accountFor(type: string): Partial<Account> {
  const k = ACCOUNT_TYPES[type];
  return { type, marginCall: k.marginCall, stopOut: k.stopOut, levCaps: {}, cryptoPct: null, maxLots: null, raw: false, commFree: [], ...k.prop };
}
// Leverage on one symbol: the account's, capped for that symbol.
export const leverageFor = (a: Account, sym: string) => Math.min(a.leverage, a.levCaps[sym] ?? Infinity, maxLeverage(sym));
// Commission in USD per lot, round turn, for a fill at `price`.
export function commissionFor(s: Session, sym: string, price: number, rate: number) {
  const a = acct(s);
  if (sym === "BTCUSD" && a.cryptoPct != null) return (a.cryptoPct / 100) * contractSize(sym) * price * rate;
  if (a.commFree.includes(sym)) return 0;
  return s.commission;
}
// Commission still to come on an open position. MT5 takes it when the order
// fills, so the balance shows it at once; realize() books it as lots close.
export const openCommission = (t: Trade) => (t.status === "open" && t.comm != null ? t.comm * t.lots : 0);

// How much wider than usual the spread is at time t (seconds): like Exness's
// floating spreads, widest in the rollover hour (17:00 New York) and wider in
// the thin Asian hours. Crypto trades all week; its spread widens at weekends.
export function spreadFactor(sym: string, t: number) {
  if (sym === "BTCUSD") { const d = new Date(t * 1000).getUTCDay(); return d === 0 || d === 6 ? 1.5 : 1; }
  const h = Math.floor((((t / 3600 - (nyDst(t) ? 4 : 5)) % 24) + 24) % 24); // New York hour
  if (h === 17) return sym === "XAUUSD" ? 4 : 5;
  if (h >= 18 || h < 2) return 1.5;
  return 1;
}

export const spreadPips = (s: Session, sym: string) => s.spreads[sym] ?? defaultSpread(sym, acct(s).raw);
// The spread as a price; with a time, floating spreads apply.
export const spreadPrice = (s: Session, sym: string, t?: number) =>
  spreadPips(s, sym) * pipSize(sym) * (t != null && acct(s).floatingSpread ? spreadFactor(sym, t) : 1);

// ------------------------------------------------------------ swap

export const swapPoints = (s: Session, sym: string) => acct(s).swapPts[sym] ?? defaultSwap(sym);

// Rollovers (17:00 New York) in (from, to] and how many nights each charges:
// forex and gold Monday to Friday with three on Wednesday (oil and indices on Friday), crypto every day once.
export function rollovers(sym: string, from: number, to: number) {
  const out: { time: number; days: number }[] = [];
  for (let d = Math.floor(from / 86400) - 1; d * 86400 <= to; d++) {
    const r = d * 86400 + (nyDst(d * 86400 + 43200) ? 21 : 22) * 3600;
    if (r <= from || r > to) continue;
    const wd = new Date(r * 1000).getUTCDay(); // the New York weekday at 17:00
    if (sym === "BTCUSD") out.push({ time: r, days: 1 });
    else if (wd >= 1 && wd <= 5) out.push({ time: r, days: wd === (sym === "USOIL" || isIndex(sym) ? 5 : 3) ? 3 : 1 });
  }
  return out;
}
export function chargeSwap(t: Trade, r: { time: number; days: number }, pts: { long: number; short: number }, rate: number) {
  const p = t.side === "buy" ? pts.long : pts.short;
  const usd = p * pointSize(t.symbol) * contractSize(t.symbol) * t.lots * rate * r.days;
  (t.swaps ||= []).push({ time: r.time, usd });
}
export const swapOf = (t: Trade) => (t.swaps || []).reduce((a, x) => a + x.usd, 0);
// Result of a trade with its swap.
export const netOf = (t: Trade) => t.pnl + swapOf(t);
// Margin a position holds now (a partial close frees its share).
export const marginOf = (t: Trade) => (t.status === "open" && t.margin ? (t.margin * t.lots) / t.initialLots : 0);

const EPS = 1e-9;

// Close `lots` of a position at `price`; returns the trade (mutated).
// `commission` ($ per lot) is for older trades that have no `comm` of their own.
export function realize(t: Trade, lots: number, price: number, time: number, rate: number, commission: number, reason: CloseReason) {
  lots = Math.min(lots, t.lots);
  const diff = t.side === "buy" ? price - t.price : t.price - price;
  const pnl = pnlUsd(t.symbol, diff, lots, rate) - (t.comm ?? commission) * lots;
  t.closes.push({ time, lots, price, pnl });
  t.pnl += pnl;
  t.lots = Math.round((t.lots - lots) * 100) / 100;
  if (t.lots <= EPS) {
    t.lots = 0;
    t.status = "closed";
    t.closedAt = time;
    t.closePrice = price;
    t.reason = reason;
  }
  return t;
}

export function openAt(t: Trade, price: number, time: number, rate: number, leverage: number, comm: (price: number) => number) {
  t.status = "open";
  t.price = price;
  t.openedAt = time;
  t.comm = comm(price);
  t.margin = marginUsd(t.symbol, t.lots, price, rate, leverage);
  t.riskUsd = t.sl == null ? null : Math.abs(pnlUsd(t.symbol, price - t.sl, t.lots, rate));
}

// Run one 1-minute candle against a pending or open trade. What happens is
// stamped at the end of that minute (open + 59 s), after the replay time the
// candle starts at, so stepping back can tell it from what you did at that time.
export function processBar(t: Trade, bar: Bar, spread: number, rate: number, commission: number, leverage: number, comm: (price: number) => number) {
  const time = bar.timestamp / 1000 + 59;
  const buy = t.side === "buy";
  // Prices the trade can trade at in this minute: buys enter on the ask.
  const ask = { open: bar.open + spread, high: bar.high + spread, low: bar.low + spread };
  let justFilled = false;

  if (t.status === "pending") {
    const p = t.price;
    if (buy && t.type === "limit" && ask.low <= p) openAt(t, Math.min(p, ask.open), time, rate, leverage, comm);
    else if (buy && t.type === "stop" && ask.high >= p) openAt(t, Math.max(p, ask.open), time, rate, leverage, comm);
    else if (!buy && t.type === "limit" && bar.high >= p) openAt(t, Math.max(p, bar.open), time, rate, leverage, comm);
    else if (!buy && t.type === "stop" && bar.low <= p) openAt(t, Math.min(p, bar.open), time, rate, leverage, comm);
    else return;
    justFilled = true;
  }
  if (t.status !== "open") return;

  // Exits: buys close on the bid (the chart), sells on the ask.
  const ex = buy ? bar : { ...ask, close: bar.close + spread };
  const gap = (level: number) => (justFilled ? level : undefined);
  if (t.sl != null) {
    const hit = buy ? ex.low <= t.sl : ex.high >= t.sl;
    if (hit) return void realize(t, t.lots, gap(t.sl) ?? (buy ? Math.min(t.sl, ex.open) : Math.max(t.sl, ex.open)), time, rate, commission, "sl");
  }
  if (t.tp != null) {
    const hit = buy ? ex.high >= t.tp : ex.low <= t.tp;
    if (hit) return void realize(t, t.lots, gap(t.tp) ?? (buy ? Math.max(t.tp, ex.open) : Math.min(t.tp, ex.open)), time, rate, commission, "tp");
  }
}

// The trades as they were at replay time `at` (seconds): everything placed,
// filled, closed or cancelled after it is undone. Moved stops and targets stay.
export function rewind(trades: Trade[], at: number): Trade[] {
  const out: Trade[] = [];
  for (const t0 of trades) {
    if (t0.createdAt > at) continue;
    const t = structuredClone(t0);
    const later = t.closes.filter((c) => c.time > at);
    if (later.length) {
      t.closes = t.closes.filter((c) => c.time <= at);
      for (const c of later) { t.lots += c.lots; t.pnl -= c.pnl; }
      t.lots = Math.round(t.lots * 100) / 100;
    }
    if ((t.status === "closed" || t.status === "cancelled") && t.closedAt! > at) {
      t.status = t.openedAt != null ? "open" : "pending";
      delete t.closedAt; delete t.closePrice; delete t.reason;
      if (t.shots) delete t.shots.exit;
    }
    if (t.swaps) t.swaps = t.swaps.filter((x) => x.time <= at);
    if (t.openedAt != null && t.openedAt > at) {
      t.status = "pending";
      t.price = t.orderPrice ?? t.price;
      t.riskUsd = null;
      delete t.openedAt; delete t.margin; delete t.comm;
      delete t.shots;
    }
    out.push(t);
  }
  return out;
}
// How many trades stepping back to `at` would change.
export const rewindCount = (trades: Trade[], at: number) =>
  trades.filter((t) => t.createdAt > at || (t.closedAt ?? 0) > at || (t.openedAt ?? 0) > at || t.closes.some((c) => c.time > at) || (t.swaps || []).some((x) => x.time > at)).length;

// Price a position would close at now, given the bid.
export const exitPrice = (t: Trade, bid: number, spread: number) => (t.side === "buy" ? bid : bid + spread);

export function floating(t: Trade, bid: number, spread: number, rate: number) {
  if (t.status !== "open") return 0;
  const px = exitPrice(t, bid, spread);
  return pnlUsd(t.symbol, t.side === "buy" ? px - t.price : t.price - px, t.lots, rate);
}

// Realised balance: start + every closed piece; swap reaches the balance when the position closes.
export const adjustOf = (s: Session) => (s.adjust || []).reduce((a, j) => a + j.usd, 0);
// Commission on open positions is taken at the fill, as in MT5.
export const balanceOf = (s: Session) => s.balance0 + adjustOf(s) + s.trades.reduce((a, t) => a + t.pnl + (t.status === "closed" ? swapOf(t) : 0) - openCommission(t), 0);

// The R multiple of a finished trade (null without a first stop).
export const rOf = (t: Trade) => (t.riskUsd ? netOf(t) / t.riskUsd : null);
