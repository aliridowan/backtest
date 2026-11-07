import { lastM1Before, symInfo } from "./market";

// US stock indices (Dow Jones, Nasdaq 100): 1 lot = 1 index, a pip = 1 index point.
export const isIndex = (sym: string) => sym === "US30" || sym === "NAS100";

// Units in one standard lot (US oil: 100 barrels, as on prop firm MT5 servers).
export const contractSize = (sym: string) => (sym === "XAUUSD" || sym === "USOIL" ? 100 : sym === "BTCUSD" || isIndex(sym) ? 1 : 100_000);
export const pipSize = (sym: string) => (sym === "BTCUSD" || isIndex(sym) ? 1 : sym === "XAUUSD" ? 0.1 : sym === "USOIL" || sym.endsWith("JPY") ? 0.01 : 0.0001);
// From the market index once loaded; pages that don't load it get the usual quoting.
export const digits = (sym: string) =>
  symInfo(sym)?.digits ?? (sym === "XAUUSD" || sym === "BTCUSD" || isIndex(sym) ? 2 : sym === "USOIL" || sym.endsWith("JPY") ? 3 : 5);
// Currency the profit is in: the last three letters of a pair; oil and the indices are priced in USD.
export const quoteOf = (sym: string) => (sym === "USOIL" || isIndex(sym) ? "USD" : sym.slice(3));

// Smallest price step (a "point", 1/10 pip on 5-digit quotes).
export const pointSize = (sym: string) => 10 ** -digits(sym);

// Margin in USD to hold `lots` at `price`: contract value / leverage (Exness caps crypto at 1:400,
// oil at 1:200, indices at 1:400 (a guess to check against MT5)).
export const maxLeverage = (sym: string) => (sym === "BTCUSD" || isIndex(sym) ? 400 : sym === "USOIL" ? 200 : Infinity);
export const marginUsd = (sym: string, lots: number, price: number, rate: number, leverage: number) =>
  (lots * contractSize(sym) * price * rate) / Math.min(leverage, maxLeverage(sym));

// Swap in points per lot per night, roughly what Exness Standard charged in
// 2024-25 (it changes every week; each session can set its own).
const SWAPS: Record<string, [number, number]> = {
  EURUSD: [-9.6, 4.1], GBPUSD: [-5.5, -1], USDJPY: [15.6, -33], USDCHF: [6, -15], AUDUSD: [-5.6, 0.4],
  USDCAD: [0.8, -8.8], NZDUSD: [-4.4, -0.6], EURGBP: [-6.4, 1.6], EURJPY: [9.8, -25], GBPJPY: [15, -38],
  AUDJPY: [7.5, -20], XAUUSD: [-45, 22], BTCUSD: [-1800, -1800], USOIL: [-30, -5],
  // Indices: about the index x US rates / 360 a night, in 0.01 points (a guess).
  US30: [-700, 200], NAS100: [-400, 100],
};
export function defaultSwap(sym: string) {
  const v = SWAPS[sym] ?? (sym.endsWith("JPY") ? [6, -18] : [-5, -1]);
  return { long: v[0], short: v[1] };
}

const MAJORS = new Set(["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"]);
// Typical retail spread in pips; each session can change it. `raw`: a
// commission account's raw spread (about what FundingPips' MT5 feed shows).
export function defaultSpread(sym: string, raw = false) {
  if (sym === "XAUUSD") return raw ? 1.5 : 2.5;
  if (sym === "BTCUSD") return raw ? 10 : 20;
  if (sym === "USOIL") return raw ? 2 : 3;
  if (sym === "US30") return raw ? 1.5 : 2.5;
  if (sym === "NAS100") return raw ? 1 : 1.5;
  if (raw) return MAJORS.has(sym) ? 0.2 : 0.8;
  return MAJORS.has(sym) ? 1 : 2;
}

// Price in `sym` that turns quote-currency money into USD at time t (seconds).
// EURGBP profit is in GBP, so it is multiplied by GBPUSD at that minute.
const rateCache = new Map<string, number>();
export async function quoteToUsd(sym: string, t: number): Promise<number> {
  const quote = quoteOf(sym);
  if (quote === "USD") return 1;
  const minute = Math.floor(t / 60);
  const key = quote + minute;
  const hit = rateCache.get(key);
  if (hit) return hit;
  let rate = 1;
  if (symInfo(quote + "USD")) {
    const b = await lastM1Before(quote + "USD", t);
    if (b) rate = b.close;
  } else if (symInfo("USD" + quote)) {
    const b = await lastM1Before("USD" + quote, t);
    if (b) rate = 1 / b.close;
  }
  rateCache.set(key, rate);
  if (rateCache.size > 5000) rateCache.clear();
  return rate;
}

// Money (USD) made by moving `diff` in price with `lots`.
export const pnlUsd = (sym: string, diff: number, lots: number, rate: number) => diff * lots * contractSize(sym) * rate;

// Lots that lose `riskUsd` if price moves `dist` against us, commission ($ per lot) included, rounded down to 0.01.
export function lotsForRisk(sym: string, riskUsd: number, dist: number, rate: number, commission = 0) {
  if (!(dist > 0) || !(rate > 0)) return 0;
  return Math.max(0.01, Math.floor((riskUsd / (dist * contractSize(sym) * rate + commission)) * 100) / 100);
}
