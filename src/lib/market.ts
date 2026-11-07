// Candle data from public/market (built by tradingMind/tools/prices.py).
// Each chunk is a .bin of int32 [time, open, high, low, close] + float32 volume
// per candle; prices are integers divided by the symbol's `scale`.

export const TF_SEC = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400, W1: 604800, MN: 2592000 } as const;
export type TF = keyof typeof TF_SEC;
export const TFS = Object.keys(TF_SEC) as TF[];

export type Bar = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };
export type Chunk = { key: string; from: number; to: number; n: number };
export type SymInfo = { name: string; group: string; scale: number; digits: number; tfs: Record<TF, Chunk[]> };
export type MarketIndex = { generated: number; timeframes: TF[]; symbols: SymInfo[] };

let indexPromise: Promise<MarketIndex> | null = null;
const SYM: Record<string, SymInfo> = {};
let generated = 0;

export function getIndex(): Promise<MarketIndex> {
  if (!indexPromise) {
    indexPromise = fetch("/market/index.json", { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`market index: ${r.status}`);
        return r.json() as Promise<MarketIndex>;
      })
      .then((idx) => {
        generated = idx.generated;
        for (const s of idx.symbols) SYM[s.name] = s;
        return idx;
      });
    indexPromise.catch(() => (indexPromise = null));
  }
  return indexPromise;
}
export const symInfo = (sym: string) => SYM[sym];
export const chunks = (sym: string, tf: TF): Chunk[] => SYM[sym]?.tfs[tf] || [];

// First and last candle time (seconds) we have for a symbol.
export function dataRange(sym: string) {
  const list = chunks(sym, "M1");
  return { from: list[0]?.from ?? 0, to: list[list.length - 1]?.to ?? 0 };
}

// ------------------------------------------------------------ time

export function nyDst(t: number) {
  const y = new Date(t * 1000).getUTCFullYear();
  const mar = Date.UTC(y, 2, 8, 7), nov = Date.UTC(y, 10, 1, 6); // 2am local
  const m = mar + ((7 - new Date(mar).getUTCDay()) % 7) * 864e5;
  const n = nov + ((7 - new Date(nov).getUTCDay()) % 7) * 864e5;
  return t * 1000 >= m && t * 1000 < n;
}
// Forex days run 17:00 to 17:00 New York (same as prices.py); BTC uses UTC.
const shift = (sym: string, t: number) => (sym === "BTCUSD" ? 0 : (nyDst(t) ? 3 : 2) * 3600);

// Close time of the `tf` candle that opens at t (seconds).
export function bucketEnd(sym: string, tf: TF, t: number) {
  if (tf !== "MN") return t + TF_SEC[tf];
  const d = new Date((t + shift(sym, t)) * 1000);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  return next - shift(sym, next);
}

// ------------------------------------------------------------ chunks

const cache = new Map<string, Promise<Bar[]>>();
const listeners = new Set<(n: number) => void>();
let busyN = 0;
const busy = (d: number) => { busyN += d; for (const l of listeners) l(busyN); };
export function onBusy(l: (n: number) => void) { listeners.add(l); return () => { listeners.delete(l); }; }

// Index of the chunk that holds time t (seconds), or -1.
export function chunkAt(list: Chunk[], t: number) {
  let lo = 0, hi = list.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].from <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function decode(buf: ArrayBuffer, scale: number): Bar[] {
  const I = new Int32Array(buf), F = new Float32Array(buf), n = I.length / 6, out = new Array<Bar>(n);
  for (let i = 0, b = 0; i < n; i++, b += 6) {
    out[i] = { timestamp: I[b] * 1000, open: I[b + 1] / scale, high: I[b + 2] / scale, low: I[b + 3] / scale, close: I[b + 4] / scale, volume: F[b + 5] };
  }
  return out;
}

export function loadChunk(sym: string, tf: TF, i: number): Promise<Bar[]> {
  const c = chunks(sym, tf)[i];
  if (!c) return Promise.resolve([]);
  const key = `${sym}/${tf}/${c.key}`;
  let p = cache.get(key);
  if (p) { cache.delete(key); cache.set(key, p); return p; } // keep recently used last
  busy(+1);
  p = fetch(`/market/${key}.bin?v=${generated}`)
    .then((r) => { if (!r.ok) throw new Error(`${key}: ${r.status}`); return r.arrayBuffer(); })
    .then((buf) => decode(buf, SYM[sym].scale))
    .finally(() => busy(-1));
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  while (cache.size > 40) cache.delete(cache.keys().next().value!);
  return p;
}

// 1-minute candles with from <= time < to (seconds).
export async function m1Range(sym: string, from: number, to: number): Promise<Bar[]> {
  const list = chunks(sym, "M1"), out: Bar[] = [];
  for (let i = Math.max(0, chunkAt(list, from)); i < list.length && list[i].from < to; i++) {
    if (list[i].to < from) continue;
    for (const b of await loadChunk(sym, "M1", i)) {
      const t = b.timestamp / 1000;
      if (t >= to) break;
      if (t >= from) out.push(b);
    }
  }
  return out;
}

// The last 1-minute candle that opened before t (the price "now" at t).
export async function lastM1Before(sym: string, t: number): Promise<Bar | null> {
  const list = chunks(sym, "M1");
  for (let i = chunkAt(list, t - 1); i >= 0; i--) {
    const bars = await loadChunk(sym, "M1", i);
    for (let j = bars.length - 1; j >= 0; j--) if (bars[j].timestamp / 1000 < t) return bars[j];
  }
  return null;
}

export function merge(bars: Bar[], ts: number): Bar | null {
  if (!bars.length) return null;
  const a: Bar = { timestamp: ts, open: bars[0].open, high: -Infinity, low: Infinity, close: bars[bars.length - 1].close, volume: 0 };
  for (const b of bars) {
    if (b.high > a.high) a.high = b.high;
    if (b.low < a.low) a.low = b.low;
    a.volume += b.volume || 0;
  }
  return a;
}

// ------------------------------------------------------------ replay feed

// Candles of one symbol/timeframe up to a replay cursor, then one at a time.
// A higher-timeframe candle still forming at the cursor is rebuilt from M1.
export class Feed {
  first = 0;
  private queue: Bar[] = [];
  private qChunk = 0;
  private qi = 0;
  private pendingFull: Bar | null = null;

  constructor(public sym: string, public tf: TF, public cursor: number) {}

  // Candles before the cursor (the last one possibly partial) and whether older ones exist.
  async load(): Promise<{ bars: Bar[]; more: boolean }> {
    const { sym, tf, cursor: C } = this, list = chunks(sym, tf);
    const i = Math.max(0, chunkAt(list, C - 1));
    const chunk = await loadChunk(sym, tf, i);
    let bars = chunk.filter((b) => b.timestamp / 1000 < C);
    let first = i;
    while (bars.length < 500 && first > 0) bars = (await loadChunk(sym, tf, --first)).concat(bars);
    let pending: Bar | null = null, held: Bar | null = null;
    const last = bars[bars.length - 1];
    if (last && tf !== "M1" && bucketEnd(sym, tf, last.timestamp / 1000) > C) {
      const part = merge(await m1Range(sym, last.timestamp / 1000, C), last.timestamp);
      if (part) { bars[bars.length - 1] = part; pending = last; } else { bars.pop(); held = last; }
    }
    this.pendingFull = pending;
    this.queue = chunk; this.qChunk = i;
    this.qi = chunk.findIndex((b) => b.timestamp / 1000 >= C);
    if (this.qi < 0) this.qi = chunk.length;
    if (held) this.qi = chunk.indexOf(held);
    this.first = first;
    return { bars, more: first > 0 };
  }

  // The next queued candle without taking it (null at the end of data).
  private async peek(): Promise<Bar | null> {
    const list = chunks(this.sym, this.tf);
    while (this.qi >= this.queue.length) {
      if (this.qChunk >= list.length - 1) return null;
      this.queue = await loadChunk(this.sym, this.tf, ++this.qChunk);
      this.qi = 0;
    }
    return this.queue[this.qi];
  }

  // The next whole candle; moves the cursor to its close. null at the end of data.
  async next(): Promise<Bar | null> {
    let bar = this.pendingFull;
    this.pendingFull = null;
    if (!bar) {
      bar = await this.peek();
      if (!bar) return null;
      this.qi++;
    }
    this.cursor = bucketEnd(this.sym, this.tf, bar.timestamp / 1000);
    return bar;
  }

  // Follow another chart to cursor C: the whole candles that closed by then,
  // and the one still forming at C rebuilt from M1 (same open time, so the
  // chart replaces it on the next call).
  async advanceTo(C: number): Promise<Bar[]> {
    const out: Bar[] = [];
    while (C > this.cursor) {
      const held = this.pendingFull;
      const bar = held ?? (await this.peek());
      if (!bar || bar.timestamp / 1000 >= C) break;
      if (!held) this.qi++;
      if (bucketEnd(this.sym, this.tf, bar.timestamp / 1000) <= C) { this.pendingFull = null; out.push(bar); continue; }
      this.pendingFull = bar;
      const part = merge(await m1Range(this.sym, bar.timestamp / 1000, C), bar.timestamp);
      if (part) out.push(part);
      break;
    }
    if (C > this.cursor) this.cursor = C;
    return out;
  }

  // The chunk before the oldest one shown (scrolling left).
  async older(): Promise<{ bars: Bar[]; more: boolean }> {
    if (this.first <= 0) return { bars: [], more: false };
    const bars = await loadChunk(this.sym, this.tf, --this.first);
    return { bars, more: this.first > 0 };
  }
}
