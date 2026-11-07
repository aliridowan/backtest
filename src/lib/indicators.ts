// Chart indicators ported from tradingMind's backtest.js: market-session boxes
// and an EMA that only recalculates the candles that changed.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { registerIndicator, type KLineData } from "klinecharts";
import { alpha, FONT, tzOffset } from "./drawings";
import type { MarketSession } from "./store";

// What the indicators need from the chart; each ReplayChart passes its own
// in the indicator's extendData (`cx`).
export type IndEnv = {
  key: () => string; // symbol/timeframe on the chart, for the EMA cache
  tfSec: () => number;
};
const NO_ENV: IndEnv = { key: () => "", tfSec: () => 3600 };
const envOf = (ind: { extendData: any }): IndEnv => ind.extendData?.cx ?? NO_ENV;

const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + (m || 0); };

// Session boxes are worked out at draw time for the candles on screen only
// (plus a day either side), so the cost does not grow with history.
type Box = { key: number; start: number; end: number; high: number; low: number; s: MarketSession };
function sessionBoxes(list: KLineData[], from: number, to: number, sessions: MarketSession[]) {
  const boxes: Box[] = [];
  for (const s of sessions) {
    if (!s.on) continue;
    const a = hm(s.start), b = hm(s.end);
    let cur: Box | null = null, hour = NaN, off = 0;
    for (let i = from; i < to; i++) {
      const t = list[i].timestamp / 1000;
      const h = Math.floor(t / 3600);
      if (h !== hour) { hour = h; off = tzOffset(s.tz, t); }
      const local = t / 60 + off;
      const m = ((local % 1440) + 1440) % 1440;
      const day = Math.floor(local / 1440);
      let key: number | null = null;
      if (a < b) { if (m >= a && m < b) key = day; }
      else if (m >= a) key = day;
      else if (m < b) key = day - 1;
      if (key === null) { cur = null; continue; }
      if (cur && cur.key === key) {
        cur.end = i;
        if (list[i].high > cur.high) cur.high = list[i].high;
        if (list[i].low < cur.low) cur.low = list[i].low;
      } else {
        cur = { key, start: i, end: i, high: list[i].high, low: list[i].low, s };
        boxes.push(cur);
      }
    }
  }
  return boxes;
}

let registered = false;
export function registerIndicators() {
  if (registered) return;
  registered = true;

  const NO_VALUES = {};
  registerIndicator({
    name: "SESSIONS", shortName: "Sessions", series: "price" as any, figures: [],
    calc: (list) => new Array(list.length).fill(NO_VALUES),
    draw: ({ ctx, kLineDataList: list, indicator, visibleRange, barSpace, xAxis, yAxis }) => {
      const tfSec = envOf(indicator).tfSec();
      if (tfSec > 3600) return true;
      const pad = Math.ceil(86400 / tfSec);
      const from = Math.max(0, visibleRange.from - pad), to = Math.min(list.length, visibleRange.to + pad);
      ctx.save();
      ctx.setLineDash([]);
      ctx.font = "11px " + FONT;
      ctx.textAlign = "center";
      const boxes = sessionBoxes(list, from, to, (indicator.extendData?.list as MarketSession[]) || [])
        .filter((b) => b.end >= visibleRange.from && b.start <= visibleRange.to)
        .map((b) => {
          const x1 = xAxis.convertToPixel(b.start) - barSpace.halfBar, x2 = xAxis.convertToPixel(b.end) + barSpace.halfBar;
          return { b, x1, x2, y1: yAxis.convertToPixel(b.high), y2: yAxis.convertToPixel(b.low) };
        });
      // Fills first, then the dashed borders and names, so overlapping sessions
      // (Sydney/Tokyo, London/New York) blend and every outline stays visible.
      for (const { b, x1, x2, y1, y2 } of boxes) {
        ctx.fillStyle = alpha(b.s.color, 0.1);
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      }
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const { b, x1, x2, y1, y2 } of boxes) {
        ctx.strokeStyle = alpha(b.s.color, 0.7);
        ctx.strokeRect(Math.round(x1) + 0.5, Math.round(y1) + 0.5, Math.round(x2 - x1), Math.round(y2 - y1));
      }
      // A name that would cover another one moves up a line.
      const placed: { l: number; r: number; y: number }[] = [];
      for (const { b, x1, x2, y1 } of [...boxes].sort((p, q) => p.x1 - q.x1)) {
        const w = ctx.measureText(b.s.name).width;
        if (x2 - x1 < Math.min(40, w)) continue;
        const cxm = (x1 + x2) / 2, l = cxm - w / 2 - 3, r = cxm + w / 2 + 3;
        let y = y1 - 5;
        while (placed.some((p) => p.l < r && l < p.r && Math.abs(p.y - y) < 12)) y -= 12;
        placed.push({ l, r, y });
        ctx.fillStyle = b.s.color;
        ctx.fillText(b.s.name, cxm, y);
      }
      ctx.restore();
      return true;
    },
  });

  // EMA that only recalculates the candles that changed (the built-in one
  // redoes the whole history on every replay step).
  type Cache = { key: string; first: number; n: number; out: any[] };
  const caches = new Map<string, Cache>(); // one per chart
  const emaFigures = (params: any[]) => params.map((p, i) => ({ key: "e" + i, title: `EMA${p}: `, type: "line" }));
  registerIndicator({
    name: "EMA", shortName: "EMA", series: "price" as any, precision: 5, shouldOhlc: true, calcParams: [20, 50, 200],
    figures: emaFigures([20, 50, 200]),
    regenerateFigures: emaFigures,
    calc: (list, ind) => {
      const params = ind.calcParams as number[], n = list.length, cx = envOf(ind), key = `${cx.key()}/${params}`;
      const c = caches.get(cx.key());
      let out: any[], start = 0;
      if (c && c.key === key && n && c.first === list[0].timestamp && c.n > 0 && c.n <= n) {
        out = c.out; start = c.n - 1;
      } else {
        out = new Array(n);
      }
      for (let i = start; i < n; i++) {
        const o: any = { run: new Array(params.length) }, prev = i > 0 ? out[i - 1].run : null, close = list[i].close;
        for (let j = 0; j < params.length; j++) {
          const v = prev ? prev[j] + (close - prev[j]) * (2 / (params[j] + 1)) : close;
          o.run[j] = v;
          if (i >= params[j] - 1) o["e" + j] = v;
        }
        out[i] = o;
      }
      out.length = n;
      if (caches.size > 20) caches.clear();
      caches.set(cx.key(), { key, first: n ? list[0].timestamp : 0, n, out });
      return out;
    },
  });
}
