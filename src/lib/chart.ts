// KLineCharts wrapper for the replay workspace: candles up to the replay
// cursor, order lines you can drag, closed-trade marks and saved drawings
// (the drawing tools themselves are in drawings.ts).

import { init, dispose, registerOverlay, ActionType, FormatDateType, OverlayMode, LoadDataType, type Chart, type KLineData, type DeepPartial, type Styles } from "klinecharts";
import { Feed, m1Range, TF_SEC, type Bar, type TF } from "./market";
import { env, FONT, isPos, type ChartEnv, lastStyle, optsOf, pick, placePosition, registerDrawings, runPosition, styleFor } from "./drawings";
import { pipSize } from "./instruments";
import { registerIndicators, type IndEnv } from "./indicators";
import { CANDLE_DEFAULT, type CandleColors, type MarketSession } from "./store";
import { fmtDay, fmtTime } from "./format";
import type { Drawing } from "./types";

export type OrderLine = {
  key: string; // `${tradeId}:${kind}`
  tradeId: string;
  kind: "entry" | "sl" | "tp";
  price: number;
  color: string;
  text: string;
  dashed: boolean;
  draggable: boolean;
};
export type TradeMark = { id: string; side: "buy" | "sell"; win: boolean; t0: number; p0: number; t1: number; p1: number };

const MUTED = "#787b86", LINE = "#2a2e39", TEXT = "#d1d4dc";
let registered = false;

function registerOverlays() {
  if (registered) return;
  registered = true;
  registerDrawings();
  registerIndicators();

  // A full-width price line with a label, e.g. "BUY 0.50  +$12.30".
  registerOverlay({
    name: "orderLine",
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      const y = coordinates[0].y, d = overlay.extendData as OrderLine;
      return [
        { type: "line", attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] }, styles: { color: d.color, size: 1, style: d.dashed ? "dashed" : "solid", dashedValue: [4, 3] } },
        // A thick invisible line so the thin one is easy to grab.
        { type: "line", attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] }, styles: { color: "rgba(0,0,0,0.001)", size: 9 } },
        {
          type: "text",
          attrs: { x: bounding.width - 6, y, text: d.text, align: "right", baseline: "middle" },
          styles: { color: "#fff", size: 11, family: FONT, backgroundColor: d.color, borderColor: d.color, borderRadius: 2, paddingLeft: 6, paddingRight: 6, paddingTop: 3, paddingBottom: 3 },
        },
      ];
    },
    createYAxisFigures: ({ coordinates, bounding, overlay, precision }) => {
      const d = overlay.extendData as OrderLine;
      return [{
        type: "text",
        attrs: { x: 0, y: coordinates[0].y, text: d.price.toFixed(precision.price), align: "left", baseline: "middle" },
        styles: { color: "#fff", size: 11, family: FONT, backgroundColor: d.color, borderColor: d.color, borderRadius: 2, paddingLeft: 4, paddingRight: 4, paddingTop: 3, paddingBottom: 3 },
        ignoreEvent: true,
      }].filter(() => bounding.width > 0);
    },
    // Only the price moves when dragging.
    performEventPressedMove: ({ points, performPoint }) => {
      points[0].value = performPoint.value;
    },
  });

  // Entry -> exit of a closed trade.
  registerOverlay({
    name: "tradeMark",
    totalStep: 3,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length < 2) return [];
      const d = overlay.extendData as TradeMark, [a, b] = coordinates;
      const color = d.win ? "#089981" : "#f23645";
      const dir = d.side === "buy" ? 1 : -1; // arrow points up for buys
      const arrow = (x: number, y: number, up: number, c: string) => ({
        type: "polygon",
        attrs: { coordinates: [{ x, y: y + up * 2 }, { x: x - 5, y: y + up * 10 }, { x: x + 5, y: y + up * 10 }] },
        styles: { style: "fill", color: c },
        ignoreEvent: true,
      });
      return [
        { type: "line", attrs: { coordinates: [a, b] }, styles: { color, size: 1, style: "dashed", dashedValue: [3, 3] }, ignoreEvent: true },
        arrow(a.x, a.y, dir, d.side === "buy" ? "#2962ff" : "#f23645"),
        { type: "circle", attrs: { x: b.x, y: b.y, r: 3.5 }, styles: { style: "fill", color }, ignoreEvent: true },
      ];
    },
  });
}

export type Indicators = { ema: boolean; emaPeriods: number[]; sessions: boolean; sessionList: MarketSession[] };

export type ChartCallbacks = {
  onLineDrag: (line: OrderLine, price: number) => void;
  onDrawingsChange: (list: Drawing[]) => void;
  onToolDone: () => void;
  onSelect: (id: string | null) => void; // the selected drawing, for its toolbar
  onSettings: (id: string) => void; // double-click
  onMenu: (id: string, x: number, y: number) => void; // right-click, x/y inside the chart
  onEditText: (id: string) => void; // a new note, or double-click on one
};

const uid = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let chartN = 0;

export class ReplayChart {
  chart: Chart;
  feed: Feed | null = null;
  tz = "UTC";
  private token = 0;
  drawings: Drawing[] = []; // on this symbol
  selectedId: string | null = null;
  private drawingId: string | null = null; // the tool being drawn
  private restoring = false;
  private hidden = false;
  private pointer = { x: 0, y: 0 };
  private digits = 5;
  private dragging = false;
  private pendingLines: OrderLine[] | null = null;
  private lines = new Map<string, { id: string; line: OrderLine }>(); // by OrderLine.key
  private markIds: string[] = [];
  private _magnet = true;
  private n = ++chartN;
  // This chart's timeframe, bar index and selection for the drawings and indicators on it.
  private cx: ChartEnv & IndEnv = {
    pip: () => pipSize(this.feed?.sym || "EURUSD"),
    digits: () => this.digits,
    barSec: () => TF_SEC[this.feed?.tf || "H1"],
    barIndex: (ms) => (this.chart as unknown as { _chartStore: { getTimeScaleStore: () => { timestampToDataIndex: (t: number) => number } } })._chartStore.getTimeScaleStore().timestampToDataIndex(ms),
    selectedId: () => this.selectedId,
    key: () => `${this.n}/${this.feed?.sym}/${this.feed?.tf}`,
    tfSec: () => TF_SEC[this.feed?.tf || "H1"],
  };

  constructor(el: HTMLElement, private cb: ChartCallbacks) {
    registerOverlays();
    // Both charts show the same symbol, so the fallback can be either.
    env.pip = this.cx.pip;
    env.digits = this.cx.digits;
    // Where the pointer was pressed, for placing the right-click menu.
    el.addEventListener("mousedown", (e) => {
      const r = el.getBoundingClientRect();
      this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    }, true);
    this.chart = init(el, { styles: themeStyles(CANDLE_DEFAULT, "candle") })!;
    this.chart.setOffsetRightDistance(120);
    this.chart.setCustomApi({ formatDate: (_d, ms, format, type) => this.formatDate(ms, format, type) });
    this.chart.setLoadDataCallback(async ({ type, callback }) => {
      if (type !== LoadDataType.Forward || !this.feed) return callback([], false);
      const token = this.token, { bars, more } = await this.feed.older();
      if (token !== this.token) return;
      callback(bars as KLineData[], more);
    });
  }

  destroy() {
    dispose(this.chart);
  }

  private formatDate(ms: number, format: string, type: FormatDateType) {
    const sec = ms / 1000, day = fmtDay(sec, this.tz), time = fmtTime(sec, this.tz);
    const daily = this.feed ? TF_SEC[this.feed.tf] >= TF_SEC.D1 : false;
    if (format === "HH:mm") return type === FormatDateType.XAxis && daily ? day : time;
    return format.includes("HH") && !daily ? `${day} ${time}` : day;
  }

  // The chart as a JPEG data URL (candles, drawings, order lines), for the trade journal.
  snapshot() {
    return this.chart.getConvertPictureUrl(true, "jpeg", this.bg);
  }

  private bg = CANDLE_DEFAULT.bg;
  setStyle(colors: Partial<CandleColors>, chartType: "candle" | "line") {
    const c = { ...CANDLE_DEFAULT, ...colors };
    this.bg = c.bg;
    this.chart.setStyles(themeStyles(c, chartType));
    (this.chart.getDom() as HTMLElement | null)?.style.setProperty("background", c.bg);
  }

  setTz(tz: string) {
    this.tz = tz;
    this.chart.setTimezone(tz);
  }

  private ind: Indicators = { ema: false, emaPeriods: [], sessions: false, sessionList: [] };
  setIndicators(ind: Indicators) {
    this.ind = ind;
    this.chart.removeIndicator("candle_pane", "EMA");
    this.chart.removeIndicator("candle_pane", "SESSIONS");
    if (ind.sessions) this.chart.createIndicator({ name: "SESSIONS", extendData: { list: ind.sessionList, cx: this.cx } }, true, { id: "candle_pane" });
    if (ind.ema && ind.emaPeriods.length) this.chart.createIndicator({ name: "EMA", calcParams: ind.emaPeriods, precision: this.digits, extendData: { cx: this.cx } }, true, { id: "candle_pane" });
  }

  // Show `sym` on `tf` with everything before `cursor`.
  async show(sym: string, tf: TF, cursor: number, digits: number, drawings: Drawing[]) {
    const token = ++this.token;
    const feed = new Feed(sym, tf, cursor);
    const { bars, more } = await feed.load();
    if (token !== this.token) return false;
    this.feed = feed;
    (this.chart as unknown as { _chartStore: { barInterval: number } })._chartStore.barInterval = TF_SEC[tf] * 1000;
    const newDigits = digits !== this.digits;
    this.digits = digits;
    this.chart.setPriceVolumePrecision(digits, 2);
    this.chart.applyNewData(bars as KLineData[], more);
    if (newDigits) this.setIndicators(this.ind); // EMA values in the symbol's digits
    this.restoreDrawings(drawings);
    await this.evaluatePositions();
    return true;
  }

  // One more candle; returns it (null at the end of the data).
  async step(): Promise<Bar | null> {
    if (!this.feed) return null;
    const token = this.token;
    const bar = await this.feed.next();
    if (!bar || token !== this.token) return null;
    this.chart.updateData(bar as KLineData);
    return bar;
  }

  // Follow another chart's replay to `cursor` (this one may show another timeframe).
  async syncTo(cursor: number) {
    if (!this.feed || cursor <= this.feed.cursor) return;
    const token = this.token, bars = await this.feed.advanceTo(cursor);
    if (token !== this.token) return;
    for (const b of bars) this.chart.updateData(b as KLineData);
  }

  // The drawings changed on the other chart.
  setDrawings(list: Drawing[]) {
    if (this.drawingId) return; // don't lose a drawing in progress; the next change brings them
    this.restoreDrawings(list);
  }

  get cursor() { return this.feed?.cursor ?? 0; }
  // Open time (seconds) of the newest candle on the chart.
  lastBarTime() {
    const last = this.chart.getDataList().at(-1);
    return last ? last.timestamp / 1000 : null;
  }

  // Crosshair moves: x inside the chart and the candle under it (none past the data).
  onCrosshair(cb: (x: number | null, bar: KLineData | null) => void) {
    const fn = (d?: unknown) => {
      const c = d as { x?: number; kLineData?: KLineData } | undefined;
      cb(c?.x ?? null, c?.kLineData ?? null);
    };
    this.chart.subscribeAction(ActionType.OnCrosshairChange, fn);
    return () => this.chart.unsubscribeAction(ActionType.OnCrosshairChange, fn);
  }

  lastClose() {
    const list = this.chart.getDataList();
    return list.length ? list[list.length - 1].close : null;
  }
  scrollToEnd() { this.chart.scrollToRealTime(); }

  // ---------------------------------------------------------- order lines

  // Lines are updated in place, not removed and re-added, so one can be
  // grabbed and dragged while the replay plays (a new overlay under the mouse
  // would drop the press and pan the chart instead).
  setOrderLines(lines: OrderLine[]) {
    if (this.dragging) { this.pendingLines = lines; return; }
    const last = this.chart.getDataList().at(-1);
    const keep = new Set(last ? lines.map((l) => l.key) : []);
    for (const [key, { id }] of this.lines) if (!keep.has(key)) { this.chart.removeOverlay({ id }); this.lines.delete(key); }
    if (!last) return;
    for (const line of lines) {
      const points = [{ timestamp: last.timestamp, value: line.price }];
      const had = this.lines.get(line.key);
      if (had) {
        had.line = line;
        this.chart.overrideOverlay({ id: had.id, points, extendData: line, lock: !line.draggable });
        continue;
      }
      const id = this.chart.createOverlay({
        name: "orderLine",
        groupId: "orders",
        lock: !line.draggable,
        zLevel: 10,
        points,
        extendData: line,
        onPressedMoveStart: () => { this.dragging = true; return false; },
        onPressedMoveEnd: (e) => {
          this.dragging = false;
          const v = e.overlay.points[0].value, cur = this.lines.get(line.key)?.line ?? line;
          if (v != null) this.cb.onLineDrag(cur, v);
          if (this.pendingLines) { const p = this.pendingLines; this.pendingLines = null; this.setOrderLines(p); }
          return false;
        },
        onRemoved: () => { if (this.lines.get(line.key)?.id === id) this.lines.delete(line.key); return false; },
      }) as string | null;
      if (id) this.lines.set(line.key, { id, line });
    }
  }

  setTradeMarks(marks: TradeMark[]) {
    for (const id of this.markIds) this.chart.removeOverlay({ id });
    this.markIds = [];
    for (const m of marks) {
      const id = this.chart.createOverlay({
        name: "tradeMark",
        groupId: "marks",
        lock: true,
        points: [{ timestamp: m.t0 * 1000, value: m.p0 }, { timestamp: m.t1 * 1000, value: m.p1 }],
        extendData: m,
      }) as string | null;
      if (id) this.markIds.push(id);
    }
  }

  // ---------------------------------------------------------- drawings

  get magnet() { return this._magnet; }
  set magnet(on: boolean) {
    this._magnet = on;
    this.chart.overrideOverlay({ groupId: "draw", mode: on ? OverlayMode.WeakMagnet : OverlayMode.Normal });
  }

  private mode() { return this._magnet ? OverlayMode.WeakMagnet : OverlayMode.Normal; }
  private extOf(d: Drawing) { return { o: optsOf(d), text: d.text, res: d.pos?.res, cx: this.cx }; }
  private save() { this.cb.onDrawingsChange(this.drawings.map((d) => structuredClone(d))); }
  getDrawing(id: string | null) { return this.drawings.find((d) => d.id === id) || null; }

  private recordOf(o: { id: string; name: string; points: Partial<{ timestamp: number; value: number }>[] }, extra?: Partial<Drawing>): Drawing {
    const prev = this.getDrawing(o.id);
    return { ...prev, id: o.id, name: o.name, points: o.points.map((p) => ({ timestamp: p.timestamp!, value: p.value! })), ...extra };
  }
  private upsert(d: Drawing) {
    const i = this.drawings.findIndex((r) => r.id === d.id);
    if (i >= 0) this.drawings[i] = d; else this.drawings.push(d);
    this.save();
  }
  private select(id: string | null) {
    this.selectedId = id;
    this.cb.onSelect(id);
  }

  private events() {
    type E = { overlay: { id: string; name: string; points: Partial<{ timestamp: number; value: number }>[] } };
    return {
      onDrawEnd: ({ overlay }: E) => {
        const d = this.recordOf(overlay, { style: isPos(overlay.name) ? undefined : pick(overlay.name, lastStyle(overlay.name)) });
        if (isPos(d.name)) {
          const list = this.chart.getDataList() as Bar[];
          placePosition(d, list, Math.min(list.length - 1, this.cx.barIndex(d.points[0].timestamp)), this.cx.barSec(), this.cursor);
          this.chart.overrideOverlay({ id: d.id, points: d.points, extendData: this.extOf(d) });
        }
        this.drawingId = null;
        this.upsert(d);
        this.cb.onToolDone();
        // The finished drawing stays selected, so show its toolbar.
        this.select(d.id);
        if (d.name === "note") this.cb.onEditText(d.id);
        return false;
      },
      onPressedMoveEnd: ({ overlay }: E) => {
        const d = this.recordOf(overlay);
        if (d.pos) d.pos = { from: d.pos.from, checked: d.pos.from, res: { s: "pending" } }; // moved: work it out again
        this.upsert(d);
        if (d.pos) void this.evaluatePositions();
        return false;
      },
      onRemoved: ({ overlay }: E) => {
        if (this.restoring) return false;
        this.drawings = this.drawings.filter((r) => r.id !== overlay.id);
        this.save();
        if (this.selectedId === overlay.id) this.select(null);
        return false;
      },
      onSelected: ({ overlay }: E) => { if (overlay.id !== this.drawingId) this.select(overlay.id); return false; },
      onDeselected: ({ overlay }: E) => {
        if (this.selectedId === overlay.id) this.selectedId = null;
        setTimeout(() => this.cb.onSelect(this.selectedId)); // another drawing may be selected right after
        return false;
      },
      // Double-click opens the settings, like TradingView (a note goes straight to its text).
      onDoubleClick: ({ overlay }: E) => {
        if (overlay.name === "note") this.cb.onEditText(overlay.id);
        else if (!isPos(overlay.name)) this.cb.onSettings(overlay.id);
        return false;
      },
      // Right-click opens the drawing's menu instead of deleting it.
      onRightClick: ({ overlay }: E) => { this.cb.onMenu(overlay.id, this.pointer.x, this.pointer.y); return true; },
    };
  }

  private createDrawing(d: Drawing) {
    this.chart.createOverlay({
      id: d.id, name: d.name, groupId: "draw", points: d.points,
      extendData: this.extOf(d), styles: styleFor(optsOf(d)), lock: !!d.lock,
      mode: this.mode(), visible: !this.hidden, zLevel: d.z || 0,
      ...this.events(),
    });
  }

  startTool(name: string) {
    this.cancelTool();
    const style = lastStyle(name);
    this.drawingId = this.chart.createOverlay({
      name, groupId: "draw", styles: styleFor(style), extendData: { o: style, cx: this.cx }, mode: this.mode(), visible: !this.hidden,
      ...this.events(),
    }) as string | null;
  }

  // Drop a drawing that was started but never finished.
  cancelTool() {
    if (this.drawingId && !this.getDrawing(this.drawingId)) {
      this.restoring = true;
      this.chart.removeOverlay({ id: this.drawingId });
      this.restoring = false;
    }
    this.drawingId = null;
  }

  removeSelected() {
    if (!this.getDrawing(this.selectedId)) return false;
    this.chart.removeOverlay({ id: this.selectedId! }); // onRemoved updates the list
    return true;
  }

  clearDrawings() {
    this.cancelTool();
    this.restoring = true;
    this.chart.removeOverlay({ groupId: "draw" });
    this.restoring = false;
    this.drawings = [];
    this.select(null);
    this.save();
  }

  setHidden(on: boolean) {
    this.hidden = on;
    this.chart.overrideOverlay({ groupId: "draw", visible: !on });
  }

  // Put a changed drawing on the chart (and save it when `save`).
  update(d: Drawing, save = true) {
    const i = this.drawings.findIndex((r) => r.id === d.id);
    if (i < 0) return;
    this.drawings[i] = d;
    this.chart.overrideOverlay({ id: d.id, styles: styleFor(optsOf(d)), extendData: this.extOf(d), points: d.points, lock: !!d.lock, zLevel: d.z || 0 });
    if (save) this.save();
    if (d.id === this.selectedId) this.cb.onSelect(d.id);
  }

  // Right-click menu choices (Settings opens in the workspace).
  menuAction(act: string, id: string) {
    const d = this.getDrawing(id);
    if (!d) return;
    if (act === "clone") {
      const copy = { ...structuredClone(d), id: uid() };
      this.drawings.push(copy);
      this.createDrawing(copy);
      this.save();
    } else if (act === "front" || act === "back") {
      const zs = this.drawings.map((r) => r.z || 0);
      this.update({ ...d, z: act === "front" ? Math.max(...zs) + 1 : Math.min(...zs) - 1 });
    } else if (act === "lock") {
      this.update({ ...d, lock: !d.lock });
    } else if (act === "remove") {
      this.chart.removeOverlay({ id });
    }
  }

  private restoreDrawings(list: Drawing[]) {
    this.cancelTool();
    this.restoring = true;
    this.chart.removeOverlay({ groupId: "draw" });
    this.restoring = false;
    this.select(null);
    this.drawings = list.map((d) => structuredClone(d));
    for (const d of this.drawings) this.createDrawing(d);
  }

  // Long/short position results on the 1-minute candles up to the cursor.
  async evaluatePositions() {
    const sym = this.feed?.sym, cur = this.cursor, token = this.token;
    if (!sym) return;
    let changed = false;
    for (const d0 of this.drawings) {
      if (!isPos(d0.name) || !d0.pos) continue;
      let { res, checked } = d0.pos;
      if (checked > cur) { res = { s: "pending" }; checked = d0.pos.from; } // went back in time
      const done = res.s === "win" || res.s === "loss";
      if (done || checked >= cur) {
        if (checked === d0.pos.checked && res === d0.pos.res) continue;
      } else {
        res = runPosition(d0, await m1Range(sym, checked, cur), res);
        checked = cur;
        if (token !== this.token) return;
      }
      const d = this.getDrawing(d0.id);
      if (!d) continue;
      d.pos = { from: d0.pos.from, checked, res };
      this.chart.overrideOverlay({ id: d.id, extendData: this.extOf(d) });
      changed = true;
    }
    if (changed) this.save();
  }
}

function themeStyles(c: CandleColors, chartType: "candle" | "line"): DeepPartial<Styles> {
  const axis = { axisLine: { color: LINE }, tickLine: { color: LINE }, tickText: { color: MUTED, family: FONT, size: 11 } };
  const cross = { line: { color: MUTED }, text: { backgroundColor: "#363a45", borderColor: "#363a45", color: TEXT, family: FONT } };
  return {
    grid: { horizontal: { color: "rgba(42,46,57,0.6)" }, vertical: { color: "rgba(42,46,57,0.6)" } },
    candle: {
      type: chartType === "line" ? "area" : "candle_solid",
      bar: { upColor: c.up, downColor: c.down, noChangeColor: MUTED, upBorderColor: c.upBorder, downBorderColor: c.downBorder, noChangeBorderColor: MUTED, upWickColor: c.upWick, downWickColor: c.downWick, noChangeWickColor: MUTED },
      area: { lineSize: 2, lineColor: c.line, value: "close", backgroundColor: [{ offset: 0, color: "rgba(0,0,0,0)" }, { offset: 1, color: "rgba(0,0,0,0)" }], point: { show: false } },
      priceMark: { high: { color: MUTED, textFamily: FONT }, low: { color: MUTED, textFamily: FONT }, last: { upColor: c.up, downColor: c.down, noChangeColor: MUTED, text: { family: FONT } } },
      tooltip: {
        showRule: "always", showType: "standard", text: { color: MUTED, size: 12, family: FONT },
        custom: [{ title: "", value: "{time}" }, { title: "O", value: "{open}" }, { title: "H", value: "{high}" }, { title: "L", value: "{low}" }, { title: "C", value: "{close}" }],
      },
    },
    indicator: {
      tooltip: { text: { color: MUTED, size: 12, family: FONT } },
      lines: ["#ff9800", "#2962ff", "#e91e63", "#00bcd4", "#8bc34a"].map((color) => ({ style: "solid", smooth: false, size: 1.5, dashedValue: [2, 2], color })),
    },
    overlay: {
      line: { color: "#2962ff" },
      point: { color: "#2962ff", borderColor: "rgba(41,98,255,0.35)", activeColor: "#2962ff", activeBorderColor: "rgba(41,98,255,0.35)" },
      rect: { color: "rgba(41,98,255,0.12)", borderColor: "#2962ff" },
      polygon: { color: "rgba(41,98,255,0.12)", borderColor: "#2962ff" },
      text: { family: FONT },
    },
    xAxis: axis,
    yAxis: axis,
    separator: { color: LINE },
    crosshair: { horizontal: cross, vertical: cross },
  } as DeepPartial<Styles>;
}
