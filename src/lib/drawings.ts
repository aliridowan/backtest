// Drawing tools like TradingView's (ported from tradingMind's drawings.js):
// what each tool can be set to, the overlays that draw with those options,
// text on lines, the long/short position tool and its result.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { getOverlayClass, registerFigure, registerOverlay, type DeepPartial, type OverlayCreateFiguresCallbackParams, type OverlayStyle } from "klinecharts";
import { usePrefs } from "./store";
import type { Bar } from "./market";
import type { Drawing, PosResult } from "./types";

export type Opts = Record<string, any>;

export const FONT = "Inter, ui-sans-serif, system-ui, sans-serif";
export const COLORS = ["#2962ff", "#f23645", "#089981", "#ff9800", "#9c27b0", "#00bcd4", "#e91e63", "#fbc02d", "#787b86", "#d1d4dc"];
const BULL = "#089981", BEAR = "#f23645", SURFACE = "#131722";
export const DASH: Record<string, number[]> = { solid: [], dashed: [6, 4], dotted: [1.5, 3] };

export const TOOLS: ({ name: string; label: string } | "-")[] = [
  { name: "segment", label: "Trend line" }, { name: "rayLine", label: "Ray" }, { name: "straightLine", label: "Extended line" },
  { name: "horizontalStraightLine", label: "Horizontal line" }, { name: "horizontalRayLine", label: "Horizontal ray" }, { name: "verticalStraightLine", label: "Vertical line" },
  { name: "parallelStraightLine", label: "Parallel channel" }, { name: "rect", label: "Rectangle" }, { name: "fib", label: "Fib retracement" },
  { name: "measure", label: "Measure (price, pips, bars)" }, { name: "note", label: "Text note" }, "-",
  { name: "longPosition", label: "Long position" }, { name: "shortPosition", label: "Short position" },
];
export const toolLabel = (name: string) => (TOOLS.find((t) => t !== "-" && t.name === name) as { label: string } | undefined)?.label ?? name;

export const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));
const lineStyle = (color: string, size: number, dash: string) => ({ color, size, style: dash === "solid" ? "solid" : "dashed", dashedValue: DASH[dash] || [] });

// ------------------------------------------------------------ options

const TEXT = { textColor: "", fontSize: 12, bold: false, italic: false, hAlign: "center", vAlign: "top" };
// TradingView's default Fib levels; the first seven are on.
const FIB_LEVELS = ([
  [0, "#787b86"], [0.236, "#f23645"], [0.382, "#ff9800"], [0.5, "#4caf50"], [0.618, "#089981"], [0.786, "#00bcd4"], [1, "#787b86"],
  [1.618, "#2962ff"], [2.618, "#f23645"], [3.618, "#9c27b0"], [4.236, "#e91e63"], [1.272, "#ff9800"], [1.414, "#f23645"],
  [2.272, "#ff9800"], [2.414, "#4caf50"], [2, "#089981"], [3, "#00bcd4"], [3.272, "#787b86"], [3.414, "#2962ff"],
  [4, "#f23645"], [4.272, "#9c27b0"], [4.414, "#e91e63"], [4.618, "#ff9800"], [4.764, "#089981"],
] as [number, string][]).map(([v, c], i) => ({ v, c, on: i < 7 }));
const DEF: Record<string, Opts> = {
  segment: { extL: false, extR: false, leftEnd: "normal", rightEnd: "normal", midPoint: false, priceLabels: false, stats: "hidden", statsPos: "right", statsAlways: false },
  rect: { fill: true, fillColor: "", fillAlpha: 0.12, midLine: false, midColor: "", midWidth: 1, midDash: "dashed", extL: false, extR: false, vAlign: "middle" },
  fib: {
    color: "#787b86", width: 1, dash: "dashed", trend: true, levelWidth: 1, levelDash: "solid", extend: "none", levels: FIB_LEVELS,
    oneColorOn: false, oneColor: "#2962ff", bg: true, bgAlpha: 0.12, reverse: false, prices: true, showLevels: true, levelsAs: "values",
    labelH: "left", labelV: "middle", fontSize: 12,
  },
};
const BASE = { color: COLORS[0], width: 1.5, dash: "solid" };
export const NO_STYLE = new Set(["longPosition", "shortPosition"]);
export const LINE_TOOLS = new Set(["segment", "rayLine", "straightLine", "horizontalStraightLine", "horizontalRayLine",
  "verticalStraightLine", "parallelStraightLine", "rect", "fib", "measure"]);
const TEXT_ON = ["rayLine", "straightLine", "parallelStraightLine", "horizontalStraightLine", "horizontalRayLine", "verticalStraightLine"];
export const TEXT_TOOLS = new Set([...TEXT_ON, "segment", "rect", "note"]);
export const isPos = (name: string) => NO_STYLE.has(name);

const merged: Record<string, Opts> = {};
// Every option a tool has, at its default (shared object: don't mutate).
export function full(name: string): Opts {
  return merged[name] || (merged[name] = { ...BASE, ...(TEXT_TOOLS.has(name) ? TEXT : {}), ...DEF[name] });
}
// The style part of a set of options (what templates and "last used" keep).
export const pick = (name: string, o: Opts) => { const out: Opts = {}; for (const k of Object.keys(full(name))) out[k] = o[k] ?? full(name)[k]; return clone(out); };
// The tool's default template (the one starred), if any.
const defaultTemplate = (name: string): Opts | undefined => { const p = usePrefs.getState(); return p.templates[name]?.[p.templateDefault[name]] as Opts | undefined; };
// What "Apply default" applies: the default template, else the built-in style.
export const defaultStyle = (name: string): Opts => clone({ ...full(name), ...defaultTemplate(name) });
// A new drawing starts with the tool's default template, or without one the
// style last used for the tool, like TradingView.
export const lastStyle = (name: string): Opts => clone({ ...full(name), ...(defaultTemplate(name) ?? usePrefs.getState().toolStyle[name]) });
// All options of a saved drawing (older ones lack the newer options).
export const optsOf = (d: Drawing): Opts => ({ ...full(d.name), ...d.style });

// What the overlays need from the chart. Each ReplayChart passes its own in
// an overlay's extendData (`cx`), since two charts can show different
// timeframes; this one is the fallback.
export type ChartEnv = { pip: () => number; digits: () => number; barSec: () => number; barIndex: (ms: number) => number; selectedId: () => string | null };
export const env: ChartEnv = {
  pip: () => 0.0001,
  digits: () => 5,
  barSec: () => 3600,
  barIndex: (_ms: number) => 0,
  selectedId: (): string | null => null,
};
const fmtP = (v: number) => v.toFixed(env.digits());

// Overlay styles from a drawing's colour, width and dash (for KLineCharts' own tools).
export function styleFor(o: Opts): DeepPartial<OverlayStyle> {
  const c = o.color || COLORS[0], width = o.width ?? 1.5, dash = o.dash || "solid";
  const style = dash === "solid" ? "solid" : "dashed", dv = DASH[dash] || [];
  return {
    line: { color: c, size: width, style, dashedValue: dv },
    polygon: { style: "stroke_fill", color: alpha(c, 0.12), borderColor: c, borderSize: width, borderStyle: style, borderDashedValue: dv },
    text: { color: c, backgroundColor: "transparent", borderSize: 0, paddingLeft: 2, paddingRight: 2, size: 11, family: FONT },
    point: { color: c, borderColor: alpha(c, 0.35), activeColor: c, activeBorderColor: alpha(c, 0.35) },
  } as DeepPartial<OverlayStyle>;
}

// The options an overlay draws with: kept in its extendData by ReplayChart.
type Ext = { o?: Opts; text?: string; res?: PosResult; cx?: ChartEnv };
const ext = (overlay: { extendData: any }): Ext => overlay.extendData || {};
const envOf = (overlay: { extendData: any }) => ext(overlay).cx ?? env;
const opts = (overlay: { name: string; extendData: any }) => ({ ...full(overlay.name), ...ext(overlay).o });

// ------------------------------------------------------------ text

const weight = (o: Opts) => `${o.italic ? "italic " : ""}${o.bold ? "bold" : "500"}`;
type Pt = { x: number; y: number };
type Fig = Record<string, any>;
type Params = OverlayCreateFiguresCallbackParams;

const textFig = (o: Opts, text: string, at: Opts): Fig => ({
  type: "rtext", ignoreEvent: true, attrs: { text, ...at },
  styles: { color: o.textColor || o.color, size: o.fontSize, weight: weight(o) },
});
// Text above, on or below a line.
const vPlace = (v: string) => (v === "middle" ? { baseline: "middle" } : v === "bottom" ? { baseline: "top", dy: 4 } : { baseline: "bottom", dy: -4 });
function lineText(o: Opts, text: string, a: Pt, b: Pt) {
  const [l, r] = a.x <= b.x ? [a, b] : [b, a];
  const at = o.hAlign === "left" ? { x: l.x, y: l.y, align: "left" }
    : o.hAlign === "right" ? { x: r.x, y: r.y, align: "right" }
    : { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2, align: "center" };
  return textFig(o, text, { ...at, angle: Math.atan2(r.y - l.y, r.x - l.x), ...vPlace(o.vAlign) });
}
const label = (bg: string, size = 11, color = "#fff") => ({ color, family: FONT, size, backgroundColor: bg, borderColor: bg, borderSize: 0, borderRadius: 3, paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3 });
const box = (x1: number, y1: number, x2: number, y2: number) => [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];

// ------------------------------------------------------------ overlays

let registered = false;
export function registerDrawings() {
  if (registered) return;
  registered = true;

  // "rtext": multi-line label turned to an angle; baseline places the block
  // above (bottom), across (middle) or below (top) its anchor.
  registerFigure({
    name: "rtext",
    checkEventOn: () => false,
    draw: (ctx: CanvasRenderingContext2D, a: any, st: any) => {
      const lines = String(a.text).split("\n"), lh = Math.round(st.size * 1.3), h = lines.length * lh;
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(a.angle || 0);
      ctx.font = `${st.weight || "500"} ${st.size}px ${FONT}`;
      ctx.fillStyle = st.color;
      ctx.textAlign = a.align || "center";
      ctx.textBaseline = "middle";
      const top = (a.dy || 0) + (a.baseline === "top" ? 0 : a.baseline === "bottom" ? -h : -h / 2);
      lines.forEach((s, i) => ctx.fillText(s, 0, top + lh * (i + 0.5)));
      ctx.restore();
    },
  });

  // ---------------- trend line

  // Far point past `to`, so an extended line leaves the chart.
  const farPoint = (from: Pt, to: Pt, b: { width: number; height: number }) => {
    const dx = to.x - from.x, dy = to.y - from.y, k = ((b.width + b.height) * 2) / (Math.hypot(dx, dy) || 1);
    return { x: to.x + dx * k, y: to.y + dy * k };
  };
  const arrow = (tip: Pt, from: Pt, size: number, color: string): Fig => {
    const a = Math.atan2(tip.y - from.y, tip.x - from.x);
    const side = (d: number) => ({ x: tip.x - size * Math.cos(a + d), y: tip.y - size * Math.sin(a + d) });
    return { type: "polygon", ignoreEvent: true, attrs: { coordinates: [tip, side(0.45), side(-0.45)] }, styles: { style: "fill", color } };
  };
  const span = (sec: number) => {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ") || "0m";
  };
  function statLines(o: Opts, overlay: Params["overlay"], a: Pt, b: Pt) {
    const [p0, p1] = overlay.points as { timestamp: number; value: number }[], d = p1.value - p0.value, sg = d >= 0 ? "+" : "";
    const pct = (d / p0.value) * 100, pips = d / env.pip();
    const cx = envOf(overlay), bars = cx.barIndex(p1.timestamp) - cx.barIndex(p0.timestamp);
    const angle = (Math.atan2(a.y - b.y, b.x - a.x) * 180) / Math.PI;
    if (o.stats === "compact") return [`${sg}${fmtP(d)} (${sg}${pct.toFixed(2)}%) · ${bars} bars`];
    return [
      `${sg}${fmtP(d)} (${sg}${pct.toFixed(2)}%) ${sg}${pips.toFixed(1)} pips`,
      `${bars} bars, ${span(Math.abs(p1.timestamp - p0.timestamp) / 1000)}`,
      `${angle.toFixed(1)}°`,
    ];
  }
  registerOverlay({
    name: "segment", totalStep: 3, needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates: c, bounding, overlay }) => {
      if (c.length < 2) return [];
      const o = opts(overlay), [a, b] = c, size = 6 + o.width * 2;
      const from = o.extL ? farPoint(b, a, bounding) : a, to = o.extR ? farPoint(a, b, bounding) : b;
      const figs: Fig[] = [{ type: "line", attrs: { coordinates: [from, to] } }];
      if (o.leftEnd === "arrow" && !o.extL) figs.push(arrow(a, b, size, o.color));
      if (o.rightEnd === "arrow" && !o.extR) figs.push(arrow(b, a, size, o.color));
      if (o.midPoint) figs.push({ type: "circle", ignoreEvent: true, attrs: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, r: 3.5 }, styles: { style: "stroke_fill", color: SURFACE, borderColor: o.color, borderSize: 1.5 } });
      const pts = overlay.points;
      if (o.priceLabels && pts.length > 1 && pts[1].value != null) {
        for (const [p, q, v] of [[a, b, pts[0].value!], [b, a, pts[1].value!]] as [Pt, Pt, number][]) {
          const up = p.y <= q.y;
          figs.push({ type: "text", ignoreEvent: true, attrs: { x: p.x, y: p.y + (up ? -8 : 8), text: fmtP(v), align: "center", baseline: up ? "bottom" : "top" }, styles: label(o.color) });
        }
      }
      const text = ext(overlay).text;
      if (text) figs.push(lineText(o, text, a, b));
      if (o.stats !== "hidden" && (o.statsAlways || envOf(overlay).selectedId() === overlay.id) && pts.length > 1 && pts[1].value != null) {
        const [l, r] = a.x <= b.x ? [a, b] : [b, a];
        const at = o.statsPos === "left" ? l : o.statsPos === "center" ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : r;
        const lines = statLines(o, overlay, a, b), lh = 20, y0 = Math.max(a.y, b.y) + (o.priceLabels ? 36 : 14);
        figs.push({ type: "text", ignoreEvent: true, attrs: lines.map((t, i) => ({ x: at.x, y: y0 + i * lh, text: t, align: "center", baseline: "top" })), styles: label(alpha(o.color, 0.9), 12) });
      }
      return figs as any;
    },
  });

  // ---------------- rectangle

  registerOverlay({
    name: "rect", totalStep: 3, needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates: c, bounding, overlay }) => {
      if (c.length < 2) return [];
      const o = opts(overlay);
      const x1 = o.extL ? 0 : Math.min(c[0].x, c[1].x), x2 = o.extR ? bounding.width : Math.max(c[0].x, c[1].x);
      const y1 = Math.min(c[0].y, c[1].y), y2 = Math.max(c[0].y, c[1].y), ym = (y1 + y2) / 2;
      const border = lineStyle(o.color, o.width, o.dash);
      const figs: Fig[] = [{
        type: "polygon",
        attrs: { coordinates: box(x1, y1, x2, y2) },
        styles: { style: o.fill ? "stroke_fill" : "stroke", color: alpha(o.fillColor || o.color, o.fillAlpha), borderColor: o.color, borderSize: o.width, borderStyle: border.style, borderDashedValue: border.dashedValue },
      }];
      if (o.midLine) figs.push({ type: "line", ignoreEvent: true, attrs: { coordinates: [{ x: x1, y: ym }, { x: x2, y: ym }] }, styles: lineStyle(o.midColor || o.color, o.midWidth, o.midDash) });
      const text = ext(overlay).text;
      if (text) {
        const pad = 6;
        const at: Opts = o.hAlign === "left" ? { x: x1 + pad, align: "left" } : o.hAlign === "right" ? { x: x2 - pad, align: "right" } : { x: (x1 + x2) / 2, align: "center" };
        Object.assign(at, o.vAlign === "top" ? { y: y1 + pad, baseline: "top" } : o.vAlign === "bottom" ? { y: y2 - pad, baseline: "bottom" } : { y: ym, baseline: "middle" });
        figs.push(textFig(o, text, at));
      }
      return figs as any;
    },
  });

  // ---------------- fib retracement

  registerOverlay({
    name: "fib", totalStep: 3, needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates: c, bounding, overlay }) => {
      if (c.length < 2) return [];
      const o = opts(overlay), pts = overlay.points;
      if (pts.length < 2 || pts[1].value == null) return [];
      // Level 1 at the first point, 0 at the second (swapped by Reverse).
      const [c0, c1] = o.reverse ? [c[1], c[0]] : [c[0], c[1]];
      const [v0, v1] = o.reverse ? [pts[1].value!, pts[0].value!] : [pts[0].value!, pts[1].value!];
      const yAt = (f: number) => c1.y + (c0.y - c1.y) * f, vAt = (f: number) => v1 + (v0 - v1) * f;
      const bx1 = Math.min(c0.x, c1.x), bx2 = Math.max(c0.x, c1.x);
      const x1 = o.extend === "left" || o.extend === "both" ? 0 : bx1;
      const x2 = o.extend === "right" || o.extend === "both" ? bounding.width : bx2;
      const levels = (o.levels as { v: number; c: string; on: boolean }[]).filter((l) => l.on && Number.isFinite(+l.v)).sort((a, b) => a.v - b.v);
      const col = (l: { c: string }) => (o.oneColorOn ? o.oneColor : l.c);
      const figs: Fig[] = [];
      if (o.bg) {
        for (let i = 1; i < levels.length; i++) {
          const ya = yAt(levels[i - 1].v), yb = yAt(levels[i].v);
          figs.push({ type: "polygon", ignoreEvent: true, attrs: { coordinates: box(x1, ya, x2, yb) }, styles: { style: "fill", color: alpha(col(levels[i]), o.bgAlpha) } });
        }
      }
      if (o.trend) figs.push({ type: "line", attrs: { coordinates: [c0, c1] }, styles: lineStyle(o.color, o.width, o.dash) });
      for (const l of levels) {
        figs.push({ type: "line", attrs: { coordinates: [{ x: x1, y: yAt(l.v) }, { x: x2, y: yAt(l.v) }] }, styles: lineStyle(col(l), o.levelWidth, o.levelDash) });
      }
      if (o.showLevels || o.prices) {
        const ax = o.labelH === "left" ? { x: bx1 - 4, align: "right" } : o.labelH === "right" ? { x: bx2 + 4, align: "left" } : { x: (bx1 + bx2) / 2, align: "center" };
        const base = o.labelV === "top" ? { baseline: "bottom", dy: -2 } : o.labelV === "bottom" ? { baseline: "top", dy: 2 } : { baseline: "middle", dy: 0 };
        for (const l of levels) {
          const name = o.levelsAs === "percents" ? `${+(l.v * 100).toFixed(2)}%` : `${l.v}`;
          const text = [o.showLevels && name, o.prices && `(${fmtP(vAt(l.v))})`].filter(Boolean).join(" ");
          figs.push({ type: "text", ignoreEvent: true, attrs: { x: ax.x, y: yAt(l.v) + base.dy, text, align: ax.align, baseline: base.baseline }, styles: { color: col(l), size: o.fontSize, family: FONT, backgroundColor: "transparent", borderSize: 0, paddingLeft: 0, paddingRight: 0 } });
        }
      }
      return figs as any;
    },
  });

  // ---------------- text on KLineCharts' own lines

  const alongLine = (o: Opts, text: string, { coordinates: [a, b] }: Params) => b && lineText(o, text, a, b);
  const PLACES: Record<string, (o: Opts, text: string, p: Params) => Fig | undefined> = {
    rayLine: alongLine, straightLine: alongLine, parallelStraightLine: alongLine,
    horizontalStraightLine: (o, text, { coordinates: [a], bounding }) => textFig(o, text, { x: bounding.width - 8, y: a.y, align: "right", ...vPlace(o.vAlign) }),
    horizontalRayLine: (o, text, { coordinates: [a, b], bounding }) => textFig(o, text, { ...(b && b.x < a.x ? { x: 8, y: a.y, align: "left" } : { x: bounding.width - 8, y: a.y, align: "right" }), ...vPlace(o.vAlign) }),
    verticalStraightLine: (o, text, { coordinates: [a] }) => textFig(o, text, { x: a.x, y: 12, angle: Math.PI / 2, align: "left", ...vPlace(o.vAlign) }),
  };
  for (const name of TEXT_ON) {
    const base = new (getOverlayClass(name)!)();
    const place = PLACES[name];
    registerOverlay({
      name, totalStep: base.totalStep, styles: base.styles,
      needDefaultPointFigure: base.needDefaultPointFigure, needDefaultXAxisFigure: base.needDefaultXAxisFigure, needDefaultYAxisFigure: base.needDefaultYAxisFigure,
      performEventPressedMove: base.performEventPressedMove, performEventMoveForDrawing: base.performEventMoveForDrawing,
      createPointFigures: (params) => {
        const figures = ([] as Fig[]).concat((base.createPointFigures?.(params) as Fig | Fig[]) ?? []);
        const text = ext(params.overlay).text, fig = text && params.coordinates.length && place(opts(params.overlay), text, params);
        if (fig) figures.push(fig);
        return figures as any;
      },
    });
  }

  // ---------------- measure and note

  registerOverlay({
    name: "measure", totalStep: 3, needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates: c, overlay }) => {
      if (c.length < 2) return [];
      const [p0, p1] = overlay.points as { timestamp: number; value: number }[];
      const d = p1.value - p0.value, up = d >= 0;
      const bars = Math.round((p1.timestamp - p0.timestamp) / (envOf(overlay).barSec() * 1000));
      const text = `${up ? "+" : ""}${fmtP(d)}  (${(d / env.pip()).toFixed(1)} pips, ${((d / p0.value) * 100).toFixed(2)}%)  ${bars} bars`;
      const col = up ? BULL : BEAR;
      return [
        { type: "polygon", attrs: { coordinates: box(c[0].x, c[0].y, c[1].x, c[1].y) }, styles: { style: "fill", color: alpha(col, 0.15) } },
        { type: "line", attrs: { coordinates: [{ x: (c[0].x + c[1].x) / 2, y: c[0].y }, { x: (c[0].x + c[1].x) / 2, y: c[1].y }] }, styles: { color: col } },
        { type: "text", ignoreEvent: true, attrs: { x: (c[0].x + c[1].x) / 2, y: c[1].y + (up ? -6 : 6), text, align: "center", baseline: up ? "bottom" : "top" }, styles: label(col) },
      ] as any;
    },
  });

  registerOverlay({
    name: "note", totalStep: 2, needDefaultPointFigure: true,
    createPointFigures: ({ coordinates: c, overlay }) => {
      const o = opts(overlay);
      return [{ type: "text", attrs: { x: c[0].x, y: c[0].y, text: ext(overlay).text || "Note", align: "left", baseline: "bottom" }, styles: { ...label(o.color, o.fontSize, o.textColor || "#fff"), weight: weight(o) } }] as any;
    },
  });

  // ---------------- long / short position

  const position = (name: string, long: boolean) => registerOverlay({
    name, totalStep: 2, needDefaultPointFigure: true, needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates: c, overlay }) => {
      if (c.length < 3) return [];
      const [e, tp, sl] = overlay.points.map((p) => p.value!);
      const x1 = Math.min(c[0].x, c[1].x), x2 = Math.max(c[0].x, c[1].x, x1 + 30), xm = (x1 + x2) / 2;
      const rr = Math.abs(tp - e) / (Math.abs(e - sl) || 1);
      const res = ext(overlay).res || { s: "pending" };
      const status = { pending: "Waiting for entry", open: "Open", win: `WIN +${(res.r || 0).toFixed(2)}R`, loss: "LOSS −1R" }[res.s];
      const sBg = { pending: "#787b86", open: "#ff9800", win: BULL, loss: BEAR }[res.s];
      const tpUp = tp > e;
      const roomy = x2 - x1 > 150; // price labels only when the box is wide enough
      // The labels show only while the position is selected (clicked).
      const on = envOf(overlay).selectedId() === overlay.id;
      return [
        { type: "polygon", attrs: { coordinates: box(x1, c[0].y, x2, c[1].y) }, styles: { style: "fill", color: alpha(BULL, 0.2) } },
        { type: "polygon", attrs: { coordinates: box(x1, c[0].y, x2, c[2].y) }, styles: { style: "fill", color: alpha(BEAR, 0.2) } },
        { type: "line", attrs: { coordinates: [{ x: x1, y: c[0].y }, { x: x2, y: c[0].y }] }, styles: { color: "#787b86", size: 1 } },
        on && roomy && { type: "text", ignoreEvent: true, attrs: { x: xm, y: c[1].y + (tpUp ? -4 : 4), text: `Target ${fmtP(tp)}  ${(Math.abs(tp - e) / env.pip()).toFixed(1)} pips`, align: "center", baseline: tpUp ? "bottom" : "top" }, styles: label(BULL) },
        on && roomy && { type: "text", ignoreEvent: true, attrs: { x: xm, y: c[2].y + (tpUp ? 4 : -4), text: `Stop ${fmtP(sl)}  ${(Math.abs(e - sl) / env.pip()).toFixed(1)} pips`, align: "center", baseline: tpUp ? "top" : "bottom" }, styles: label(BEAR) },
        on && { type: "text", ignoreEvent: true, attrs: { x: xm, y: c[0].y, text: roomy ? `${long ? "Long" : "Short"} ${fmtP(e)} · R:R ${rr.toFixed(2)} · ${status}` : status, align: "center", baseline: "middle" }, styles: label(sBg) },
      ].filter(Boolean) as any;
    },
    // The stop handle stays under the entry handle.
    performEventPressedMove: ({ points, performPointIndex }) => {
      if (performPointIndex === 0 || performPointIndex === 2) {
        points[2].timestamp = points[0].timestamp;
        points[2].dataIndex = points[0].dataIndex;
      }
    },
  });
  position("longPosition", true);
  position("shortPosition", false);
}

// ------------------------------------------------------------ positions

// A new long/short position: entry where clicked, 1R stop from recent range, 2R target.
export function placePosition(d: Drawing, list: Bar[], idx: number, barSec: number, cursor: number) {
  const long = d.name === "longPosition", p = d.points[0];
  let range = 0, n = 0;
  for (let i = Math.max(0, idx - 14); i <= idx && i < list.length; i++, n++) range += list[i].high - list[i].low;
  const risk = (n ? range / n : p.value * 0.002) * 1.5;
  const width = barSec * 1000 * 20;
  d.points = [
    { timestamp: p.timestamp, value: p.value },
    { timestamp: p.timestamp + width, value: p.value + (long ? 2 : -2) * risk },
    { timestamp: p.timestamp, value: p.value + (long ? -1 : 1) * risk },
  ];
  // The trade can only fill after the current candle.
  d.pos = { from: cursor, checked: cursor, res: { s: "pending" } };
}

const rrOf = (d: Drawing) => Math.abs(d.points[1].value - d.points[0].value) / (Math.abs(d.points[0].value - d.points[2].value) || 1);
// Walk 1-minute candles: the trade fills when price touches the entry, then
// whichever of stop/target is touched first decides it (stop wins a tie).
export function runPosition(d: Drawing, bars: Bar[], res: PosResult): PosResult {
  const long = d.name === "longPosition";
  const e = d.points[0].value, tp = d.points[1].value, sl = d.points[2].value;
  const start = d.pos?.from ?? d.points[0].timestamp / 1000;
  for (const b of bars) {
    const t = b.timestamp / 1000;
    if (t < start) continue;
    if (res.s === "pending") {
      if (b.low <= e && b.high >= e) res = { s: "open", fill: t };
      else continue;
    }
    if (long ? b.low <= sl : b.high >= sl) return { s: "loss", r: -1, fill: res.fill, exit: t };
    if (long ? b.high >= tp : b.low <= tp) return { s: "win", r: rrOf(d), fill: res.fill, exit: t };
  }
  return res;
}

// ------------------------------------------------------------ time zone

const dtfCache: Record<string, Intl.DateTimeFormat> = {};
// Minutes to add to UTC to get wall-clock time in `tz`.
export function tzOffset(tz: string, sec: number) {
  const hr = Math.floor(sec / 3600);
  const f = dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  }));
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(hr * 3600000))) p[x.type] = x.value;
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - hr * 3600000) / 60000;
}
// datetime-local value for a time (ms) in `tz`, and back.
export const toLocal = (ms: number, tz: string) => new Date(ms + tzOffset(tz, ms / 1000) * 60000).toISOString().slice(0, 16);
export function fromLocal(v: string, tz: string) {
  const [d, tm] = v.split("T"), [y, mo, da] = d.split("-").map(Number), [h, mi] = tm.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, da, h, mi) / 1000;
  return (wall - tzOffset(tz, wall) * 60) * 1000;
}
