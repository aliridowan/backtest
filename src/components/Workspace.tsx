"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReplayChart, type OrderLine, type TradeMark } from "@/lib/chart";
import { bucketEnd, dataRange, getIndex, lastM1Before, type Bar, m1Range, onBusy, TF_SEC, TFS, type MarketIndex, type TF } from "@/lib/market";
import { contractSize, defaultSwap, digits, marginUsd, pnlUsd, quoteToUsd } from "@/lib/instruments";
import { accountFor, ACCOUNT_TYPES, acct, adjustOf, balanceOf, chargeSwap, commissionFor, leverageFor, openCommission, exitPrice, floating, LEVERAGES, marginOf, openAt, processBar, realize, rewind, rewindCount, rollovers, spreadPips, spreadPrice, swapOf, swapPoints } from "@/lib/broker";
import { chartTz, uid, usePrefs, useSessions } from "@/lib/store";
import { dateInput, fmtDateTime, fmtMoney, fromDateInput, pnlClass } from "@/lib/format";
import type { Challenge, Session, Trade } from "@/lib/types";
import { CHALLENGES, challengeFrom, challengeState, dayStart, floors, NEXT_PHASE } from "@/lib/challenge";
import { deleteShots, putShot, shotKey, type ShotKind } from "@/lib/shots";
import { SetupsDialog, TradeJournal, type JournalChange } from "./Journal";
import { ChallengePanel, challengeBadge } from "./Challenge";
import OrderPanel, { type DraftDrag, type OrderDraft, type OrderRequest } from "./OrderPanel";
import TradesPanel from "./TradesPanel";
import ChartSettings from "./ChartSettings";
import IndicatorMenu from "./IndicatorMenu";
import { DrawBar, DrawingSettings, DrawMenu, TextEdit, ToolColumn } from "./DrawingTools";
import { Icon } from "./icons";

type Live = { bid: Record<string, number>; rate: Record<string, number> };
const isActive = (t: Trade) => t.status === "pending" || t.status === "open";
type Mod = { sl?: number | null; tp?: number | null; price?: number };
// The session at replay time T: a challenge failure after T is undone with the trades.
const unfail = (x: Session, T: number): Challenge | undefined => (x.challenge?.failed && x.challenge.failed.time > T ? { ...x.challenge, failed: undefined } : x.challenge);
const SPEEDS = [1, 2, 5, 10, 20];
// The second chart's timeframe until one is saved: two steps up (M15 -> H1).
const tfOf = (s: Session, i: number): TF => (i === 0 ? s.tf : s.tf2 ?? TFS[Math.min(TFS.indexOf(s.tf) + 2, TFS.length - 1)] ?? "H4");
const TZS: [string, string][] = [["", "Local"], ["UTC", "UTC"], ["America/New_York", "New York"], ["Europe/London", "London"], ["Asia/Tokyo", "Tokyo"]];

// Exness-style account numbers: equity counts open profit and swap; margin level = equity / margin.
function accountOf(s: Session, lv: Live) {
  const balance = balanceOf(s);
  let equity = balance, margin = 0;
  for (const t of s.trades) {
    if (t.status !== "open") continue;
    const bid = lv.bid[t.symbol];
    equity += swapOf(t) + (bid != null ? floating(t, bid, spreadPrice(s, t.symbol, s.cursor), lv.rate[t.symbol] ?? 1) : 0);
    margin += marginOf(t);
  }
  return { balance, equity, margin, free: equity - margin, level: margin > 0 ? (equity / margin) * 100 : null };
}

export default function Workspace({ id }: { id: string }) {
  const router = useRouter();
  const session = useSessions((s) => s.sessions[id]);
  const prefs = usePrefs();
  const tz = chartTz(prefs.tz);

  // One chart, or two side by side (prefs.split). rcRef is the active one: the
  // one last clicked, which the timeframe buttons, drawing tools and replay
  // steps act on; the other follows its replay time.
  const elRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const charts = useRef<(ReplayChart | null)[]>([null, null]);
  const rcRef = useRef<ReplayChart | null>(null);
  const activeRef = useRef(0);
  const [active, setActive] = useState(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inFlight = useRef(0);
  const liveRef = useRef<Live>({ bid: {}, rate: {} });

  const [index, setIndex] = useState<MarketIndex | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(0);
  const [live, setLive] = useState<Live>({ bid: {}, rate: {} });
  const [playing, setPlaying] = useState(false);
  const [notice, setNotice] = useState("");
  const [tool, setTool] = useState<string | null>(null);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [menu, setMenu] = useState<"" | "chart" | "ind" | "session" | "jump" | "chal">("");
  // Trade journal page and the setups dialog.
  const [journalId, setJournalId] = useState<string | null>(null);
  const [setupsOpen, setSetupsOpen] = useState(false);
  const [jumpTo, setJumpTo] = useState("");
  // Drawings: the selected one (for its toolbar), its settings dialog, right-click menu and text box.
  const [selId, setSelId] = useState<string | null>(null);
  const [, setRev] = useState(0);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [drawMenu, setDrawMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [textId, setTextId] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const hiddenRef = useRef(false);
  hiddenRef.current = hidden;
  // The order being set up in the order panel, shown as lines on the chart.
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [draftDrag, setDraftDrag] = useState<DraftDrag | null>(null);
  // Entry / SL / TP moved on the chart wait here until Confirm (like Exness's Modify);
  // the trade keeps its old levels till then.
  const [mods, setMods] = useState<Record<string, Mod>>({});
  // "Select bar": click a candle to replay from it.
  const [picking, setPicking] = useState(false);
  const [pickX, setPickX] = useState<number | null>(null);
  const [pickConfirm, setPickConfirm] = useState<{ target: number; bar: number; n: number } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const settingsOpen = useRef(false);
  settingsOpen.current = settingsId != null;

  const get = () => useSessions.getState().sessions[id];
  // Leave for the dashboard first, so the screen never shows a missing session.
  const deleteSession = () => {
    setPlaying(false);
    router.push("/dashboard");
    useSessions.getState().remove(id);
    deleteShots(id).catch(() => {});
  };
  const allCharts = () => charts.current.filter((c): c is ReplayChart => !!c);
  const others = () => allCharts().filter((c) => c !== rcRef.current);
  // Every chart at replay time `cursor`; false when a newer show replaced it.
  const showAll = async (cursor: number) => {
    const s = get(), list = s.drawings[s.symbol] || [];
    let ok = true;
    for (let i = 0; i < 2; i++) {
      const c = charts.current[i];
      if (c && !(await c.show(s.symbol, tfOf(s, i), cursor, digits(s.symbol), list))) ok = false;
    }
    return ok;
  };
  const patch = (fn: (s: Session) => Session) => useSessions.getState().update(id, fn);

  // Remember when the session was last opened (the dashboard's "Continue").
  useEffect(() => { patch((s) => ({ ...s, usedAt: Date.now() })); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (typeof window !== "undefined" && window.innerWidth < 1024) setBottomOpen(false); }, []);

  // Everything that touches the replay or the trades runs one after another.
  const enqueue = useCallback(<T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    inFlight.current++;
    const p = queue.current.then(fn).catch((e) => { console.error(e); setNotice(String(e?.message || e)); return undefined; })
      .finally(() => { inFlight.current--; });
    queue.current = p;
    return p;
  }, []);

  // Current bid and quote->USD rate for the chart symbol and every symbol with orders.
  const refreshLive = async () => {
    const s = get(), rc = rcRef.current;
    if (!s || !rc) return;
    const syms = new Set(s.trades.filter(isActive).map((t) => t.symbol));
    syms.add(s.symbol);
    const next: Live = { bid: {}, rate: {} };
    for (const sym of syms) {
      const bid = sym === s.symbol ? rc.lastClose() : (await lastM1Before(sym, s.cursor))?.close;
      if (bid != null) next.bid[sym] = bid;
      next.rate[sym] = await quoteToUsd(sym, s.cursor);
    }
    liveRef.current = next;
    setLive(next);
  };

  // Run every pending/open order through the 1-minute candles in [prev, cur),
  // all symbols together in time order, with Exness's rules: swap at each
  // rollover, free margin checked when a pending order triggers, and stop out
  // (the most losing position first) when the margin level falls to the limit.
  // In a challenge, equity reaching the daily or max loss floor closes everything.
  const advance = async (prev: number, cur: number) => {
    const s = get(), a = acct(s), ch = s.challenge && !s.challenge.failed ? s.challenge : null;
    let negFix: { time: number; usd: number } | null = null;
    let failed: Challenge["failed"] | null = null;
    const changed = new Map<string, Trade>();
    for (const t of s.trades) if (isActive(t)) changed.set(t.id, structuredClone(t));
    const active = [...changed.values()];
    if (active.length) {
      type Ev = { t: number; sym: string; bar?: Bar; roll?: { time: number; days: number } };
      const evs: Ev[] = [], rate: Record<string, number> = {}, bySym = new Map<string, Trade[]>();
      for (const t of active) bySym.set(t.symbol, [...(bySym.get(t.symbol) || []), t]);
      for (const sym of bySym.keys()) {
        rate[sym] = await quoteToUsd(sym, cur);
        for (const bar of await m1Range(sym, prev, cur)) evs.push({ t: bar.timestamp / 1000, sym, bar });
        if (a.swaps) for (const r of rollovers(sym, prev, cur)) evs.push({ t: r.time - 0.5, sym, roll: r });
      }
      evs.sort((x, y) => x.t - y.t);

      // Balance from the trades this step can't change; the active ones are added as they go.
      const fixed = s.balance0 + adjustOf(s) + s.trades.reduce((sum, t) => sum + (changed.has(t.id) ? 0 : t.pnl + (t.status === "closed" ? swapOf(t) : 0)), 0);
      const last: Record<string, Bar> = {};
      const openOn = (sym: string) => active.filter((t) => t.status === "open" && t.symbol === sym);
      // Money per unit of bid price on a symbol (> 0 when net long).
      const exposure = (sym: string) => openOn(sym).reduce((k, t) => k + (t.side === "buy" ? 1 : -1) * t.lots * contractSize(sym) * rate[sym], 0);
      // The bid that hurts the account most in each symbol's latest minute.
      const worstBid = (sym: string) => {
        const b = last[sym];
        if (!b) return liveRef.current.bid[sym] ?? null;
        return exposure(sym) >= 0 ? b.low : b.high;
      };
      const pnlAt = (t: Trade, bid: number | null) => {
        if (bid == null) return 0;
        const px = exitPrice(t, bid, spreadPrice(s, t.symbol, last[t.symbol] ? last[t.symbol].timestamp / 1000 : prev));
        return pnlUsd(t.symbol, t.side === "buy" ? px - t.price : t.price - px, t.lots, rate[t.symbol]);
      };
      const account = (bids: Record<string, number | null>) => {
        let equity = fixed, used = 0;
        for (const t of active) {
          equity += t.pnl + (t.status === "closed" ? swapOf(t) : 0);
          if (t.status === "open") { equity += swapOf(t) + pnlAt(t, bids[t.symbol]) - openCommission(t); used += marginOf(t); }
        }
        return { equity, used };
      };
      const worstBids = () => Object.fromEntries([...bySym.keys()].map((sym) => [sym, worstBid(sym)]));
      // Challenge floors change only with the day or when something closes.
      const all = s.trades.map((t) => changed.get(t.id) ?? t);
      let fl = null as { key: string; daily: number; max: number } | null;
      for (const ev of evs) {
        const list = bySym.get(ev.sym)!;
        if (ev.roll) {
          const pts = swapPoints(s, ev.sym);
          for (const t of list) if (t.status === "open" && t.openedAt! < ev.roll.time) chargeSwap(t, ev.roll, pts, rate[ev.sym]);
          continue;
        }
        const bar = ev.bar!, spr = spreadPrice(s, ev.sym, ev.t), lev = leverageFor(a, ev.sym);
        const comm = (px: number) => commissionFor(s, ev.sym, px, rate[ev.sym]);
        let free: number | null = null;
        for (const t of list) {
          if (!isActive(t)) continue;
          if (t.status !== "pending") { processBar(t, bar, spr, rate[ev.sym], s.commission, lev, comm); continue; }
          if (free == null) { const ac = account(worstBids()); free = ac.equity - ac.used; }
          const before = structuredClone(t);
          processBar(t, bar, spr, rate[ev.sym], s.commission, lev, comm);
          if (t.status === "pending") continue;
          // Exness checks the free margin when a pending order triggers; without it the order is cancelled.
          if ((t.margin ?? 0) > free) {
            for (const k of Object.keys(t)) delete (t as Record<string, unknown>)[k];
            Object.assign(t, before, { status: "cancelled", closedAt: ev.t + 59, reason: "margin" });
          } else free -= t.margin ?? 0;
        }
        last[ev.sym] = bar;
        // Stop out: when the margin level reaches the limit, the most losing position
        // closes at the price where that happens (or the open after a gap).
        for (;;) {
          const open = active.filter((t) => t.status === "open");
          if (!open.length) break;
          const bids = worstBids(), { equity, used } = account(bids), limit = (a.stopOut / 100) * used;
          if (!(used > 0) || equity > limit) break;
          const k = exposure(ev.sym), w = bids[ev.sym]!;
          let at = k ? w + (limit - equity) / k : w;
          if (k ? (at - bar.open) * Math.sign(k) > 0 : false) at = bar.open; // already past it at the open
          at = Math.min(bar.high, Math.max(bar.low, at));
          bids[ev.sym] = at;
          const t = open.reduce((x, y) => (pnlAt(y, bids[y.symbol]) < pnlAt(x, bids[x.symbol]) ? y : x));
          const px = exitPrice(t, bids[t.symbol] ?? t.price, spreadPrice(s, t.symbol, ev.t));
          realize(t, t.lots, Number(px.toFixed(digits(t.symbol))), ev.t + 59, rate[t.symbol], s.commission, "stopout");
        }
        if (ch && active.some((t) => t.status === "open")) {
          const key = `${dayStart(ev.t)}:${active.reduce((n, t) => n + t.closes.length, 0)}`;
          if (fl?.key !== key) { const f = floors(s, ch, all, ev.t); fl = { key, daily: f.daily, max: f.max }; }
          const bids = worstBids(), { equity } = account(bids), floor = Math.max(fl.daily, fl.max);
          if (equity <= floor) {
            // Close everything where equity met the floor (or at the open after a gap).
            const k = exposure(ev.sym), w = bids[ev.sym]!;
            let at = k ? w + (floor - equity) / k : w;
            if (k ? (at - bar.open) * Math.sign(k) > 0 : false) at = bar.open;
            bids[ev.sym] = Math.min(bar.high, Math.max(bar.low, at));
            const time = ev.t + 59, eq = account(bids).equity;
            for (const t of active) {
              if (t.status === "open") realize(t, t.lots, Number(exitPrice(t, bids[t.symbol] ?? t.price, spreadPrice(s, t.symbol, ev.t)).toFixed(digits(t.symbol))), time, rate[t.symbol], s.commission, "breach");
              else if (t.status === "pending") { t.status = "cancelled"; t.closedAt = time; }
            }
            failed = { time, reason: fl.daily >= fl.max ? "daily" : "max", equity: eq };
            break;
          }
        }
      }
      // Negative balance protection: with nothing left open, a balance below zero is reset to zero.
      if (!active.some((t) => t.status === "open")) {
        const bal = account({}).equity;
        if (bal < 0) negFix = { time: cur, usd: -bal };
      }
    }
    patch((x) => ({ ...x, cursor: cur, trades: x.trades.map((t) => changed.get(t.id) ?? t), ...(negFix ? { adjust: [...(x.adjust || []), negFix] } : {}), ...(failed && x.challenge ? { challenge: { ...x.challenge, failed } } : {}) }));
    if (failed) { setPlaying(false); setNotice(`Challenge failed: ${failed.reason === "daily" ? "daily loss limit" : "maximum loss"} hit.`); }
  };

  // ---------------------------------------------------------- setup

  useEffect(() => {
    getIndex().then(setIndex, (e) => setNotice(`Could not load market data: ${e}`));
    return onBusy(setLoading);
  }, []);

  // Chart i on its element. Selection, menus and tool events count only on the
  // active chart; drawing changes are copied to the other one.
  const makeChart = (i: number, el: HTMLDivElement) => {
    const mine = () => activeRef.current === i;
    const rc = new ReplayChart(el, {
      onLineDrag: (line, price) => { void onLineDrag(line, price); },
      onDrawingsChange: (list) => {
        patch((x) => ({ ...x, drawings: { ...x.drawings, [x.symbol]: list } }));
        for (const c of allCharts()) if (c !== rc) c.setDrawings(list);
        setRev((r) => r + 1);
      },
      onToolDone: () => { if (mine()) setTool(null); },
      onSelect: (sid) => { if (mine()) { setSelId(sid); setRev((r) => r + 1); } },
      onSettings: (sid) => { if (mine()) { setDrawMenu(null); setSettingsId(sid); } },
      onMenu: (sid, x, y) => { if (mine()) setDrawMenu({ id: sid, x, y }); },
      onEditText: (sid) => { if (mine()) setTextId(sid); },
    });
    charts.current[i] = rc;
    if (mine()) rcRef.current = rc;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __rcs: (ReplayChart | null)[] }).__rcs = charts.current; // for debugging in the console
    const p = usePrefs.getState();
    rc.setTz(chartTz(p.tz));
    rc.setStyle(p.colors, p.chartType);
    rc.setIndicators(p);
    rc.magnet = p.magnet;
    if (hiddenRef.current) rc.setHidden(true);
    const ro = new ResizeObserver(() => rc.chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect(); rc.destroy(); charts.current[i] = null;
      if (rcRef.current === rc) rcRef.current = charts.current[0];
    };
  };

  useEffect(() => {
    if (!elRefs[0].current || !index || !get()) return;
    activeRef.current = 0; setActive(0);
    const off = makeChart(0, elRefs[0].current);
    const rc = charts.current[0]!;
    enqueue(async () => {
      const s = get();
      await rc.show(s.symbol, s.tf, s.cursor, digits(s.symbol), s.drawings[s.symbol] || []);
      await refreshLive();
      setReady(true);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, id]);

  // The second chart, at the same replay time.
  useEffect(() => {
    if (!prefs.split || !ready || !elRefs[1].current) return;
    const off = makeChart(1, elRefs[1].current);
    const rc = charts.current[1]!;
    enqueue(async () => {
      if (!get().tf2) patch((x) => ({ ...x, tf2: tfOf(x, 1) })); // keep it when the first chart's timeframe changes
      const s = get();
      await rc.show(s.symbol, tfOf(s, 1), s.cursor, digits(s.symbol), s.drawings[s.symbol] || []);
      await refreshLive(); // redraws the order lines, now on this chart too
    });
    return () => {
      if (activeRef.current === 1) activate(0);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.split, ready, id]);

  // Clicking a chart makes it the active one; a drawing tool that was picked moves with it.
  const activate = (i: number) => {
    const next = charts.current[i];
    if (activeRef.current === i || !next) return;
    rcRef.current?.cancelTool();
    activeRef.current = i; rcRef.current = next; setActive(i);
    setSelId(null); setDrawMenu(null); setSettingsId(null); setTextId(null); setPicking(false); setPickX(null);
    if (tool) next.startTool(tool);
  };

  useEffect(() => { for (const c of allCharts()) c.setStyle(prefs.colors, prefs.chartType); }, [prefs.colors, prefs.chartType]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { for (const c of allCharts()) c.setIndicators(prefs); }, [prefs.ema, prefs.emaPeriods, prefs.sessions, prefs.sessionList]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { for (const c of allCharts()) c.magnet = prefs.magnet; }, [prefs.magnet]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!rcRef.current || !ready) return;
    for (const c of allCharts()) c.setTz(tz);
    enqueue(async () => { const s = get(); await showAll(s.cursor); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  // ---------------------------------------------------------- replay

  const step = () => enqueue(async () => {
    const rc = rcRef.current, s = get();
    if (!rc || !s) return;
    if (s.endTime && rc.cursor >= s.endTime) { setPlaying(false); setNotice("The session's end date is reached."); return; }
    const prev = rc.cursor;
    const bar = await rc.step();
    if (!bar) { setPlaying(false); setNotice("No more data for this symbol."); return; }
    for (const c of others()) await c.syncTo(rc.cursor);
    await advance(prev, rc.cursor);
    await rc.evaluatePositions();
    await refreshLive();
  });

  useEffect(() => {
    if (!playing) return;
    setNotice("");
    const timer = setInterval(() => { if (inFlight.current === 0) step(); }, 1000 / prefs.speed);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, prefs.speed]);

  // Back to replay time `target`: the trades are rewound to how they were then.
  const goBack = async (target: number) => {
    const rc = rcRef.current, s = get();
    if (!rc || target >= s.cursor) return;
    setPlaying(false);
    if (!(await showAll(target))) return;
    const T = rc.cursor || target;
    patch((x) => ({ ...x, cursor: T, trades: rewind(x.trades, T), adjust: (x.adjust || []).filter((j) => j.time <= T), challenge: unfail(x, T) }));
    await rc.evaluatePositions();
    await refreshLive();
    setNotice("");
  };

  // One candle back (the newest candle goes away), like TradingView's replay.
  const stepBack = () => enqueue(async () => {
    const rc = rcRef.current, s = get();
    if (!rc || !s) return;
    const t = rc.lastBarTime();
    if (t == null || t <= dataRange(s.symbol).from) { setNotice("This is the start of the data."); return; }
    await goBack(t);
  });

  // Replay from the picked candle (it becomes the newest one).
  const pickBar = (bar: { timestamp: number }) => {
    const s = get();
    setPicking(false); setPickX(null);
    const target = bucketEnd(s.symbol, tfOf(s, activeRef.current), bar.timestamp / 1000);
    if (target >= s.cursor) return;
    const n = rewindCount(s.trades, target);
    if (n) setPickConfirm({ target, bar: bar.timestamp / 1000, n });
    else enqueue(() => goBack(target));
  };

  // Forward runs the orders through the skipped candles. Back closes open
  // trades at the current price and cancels pending orders first, since their
  // future is already known.
  const jump = () => enqueue(async () => {
    const rc = rcRef.current, s = get();
    if (!rc || !jumpTo) return;
    const target = fromDateInput(jumpTo), range = dataRange(s.symbol);
    if (target === s.cursor) return;
    if (target < range.from || target > range.to) { setNotice(`${s.symbol} has data from ${dateInput(range.from)} to ${dateInput(range.to)}.`); return; }
    setPlaying(false);
    if (target < s.cursor) {
      const { bid, rate } = liveRef.current;
      patch((x) => ({
        ...x,
        trades: x.trades.map((t0) => {
          if (!isActive(t0)) return t0;
          const t = structuredClone(t0);
          if (t.status === "pending" || bid[t.symbol] == null) { t.status = "cancelled"; t.closedAt = x.cursor; }
          else realize(t, t.lots, exitPrice(t, bid[t.symbol], spreadPrice(x, t.symbol, x.cursor)), x.cursor, rate[t.symbol] ?? 1, x.commission, "manual");
          return t;
        }),
      }));
    }
    await showAll(target);
    if (target > s.cursor) await advance(s.cursor, target);
    else patch((x) => ({ ...x, cursor: rc.cursor || target }));
    await refreshLive();
    setMenu("");
    setNotice("");
  });

  // A new symbol goes on every chart; a timeframe on the active one.
  const show = (change: { symbol?: string; tf?: TF }) => enqueue(async () => {
    const rc = rcRef.current, i = activeRef.current;
    if (!rc) return;
    if (change.symbol) patch((x) => ({ ...x, symbol: change.symbol! }));
    if (change.tf) {
      const tf = change.tf;
      patch((x) => (i === 0 ? { ...x, tf } : { ...x, tf2: tf }));
      if (i === 0) usePrefs.getState().set({ lastTf: tf });
    }
    const s = get();
    rc.cancelTool(); setTool(null);
    if (change.symbol) await showAll(s.cursor);
    else await rc.show(s.symbol, tfOf(s, i), s.cursor, digits(s.symbol), s.drawings[s.symbol] || []);
    await refreshLive();
  });

  // ---------------------------------------------------------- orders

  const place = (o: OrderRequest) => enqueue(async (): Promise<string | null> => {
    const s = get(), rc = rcRef.current, sym = s.symbol;
    const bid = rc?.lastClose();
    if (bid == null) return "No price yet.";
    // No trading over the weekend: the last minute candle must be recent.
    if (o.type === "market") {
      const m1 = await lastM1Before(sym, s.cursor);
      if (!m1 || s.cursor - m1.timestamp / 1000 > 3600) return "The market is closed now. Step forward to the next open, or place a pending order.";
    }
    const spr = spreadPrice(s, sym, s.cursor), ask = bid + spr, buy = o.side === "buy", dg = digits(sym);
    const entry = o.type === "market" ? (buy ? ask : bid) : o.price!;
    if (o.type === "limit" && (buy ? entry >= ask : entry <= bid)) return buy ? "A buy limit goes below the ask." : "A sell limit goes above the bid.";
    if (o.type === "stop" && (buy ? entry <= ask : entry >= bid)) return buy ? "A buy stop goes above the ask." : "A sell stop goes below the bid.";
    const sl = o.sl == null ? null : Number(o.sl.toFixed(dg)), tp = o.tp == null ? null : Number(o.tp.toFixed(dg));
    if (sl != null && (buy ? sl >= entry : sl <= entry)) return `The stop loss must be ${buy ? "below" : "above"} the open price.`;
    if (tp != null && (buy ? tp <= entry : tp >= entry)) return `The take profit must be ${buy ? "above" : "below"} the open price.`;
    if (s.challenge?.failed) return "The challenge failed. Step back to before the breach to try again.";
    const a = acct(s);
    if (a.maxLots != null && o.lots > a.maxLots) return `This account allows at most ${a.maxLots} lots per order.`;
    const t: Trade = {
      id: uid(), symbol: sym, side: o.side, type: o.type, status: "pending",
      lots: o.lots, initialLots: o.lots, price: entry, sl, tp, initialSl: sl,
      createdAt: s.cursor, closes: [], pnl: 0, riskUsd: null, note: "", tags: [],
      ...(o.setup ? { setup: o.setup, checks: o.checks } : {}),
    };
    if (o.type === "market") {
      // Free margin must cover the new position.
      const rate = await quoteToUsd(sym, s.cursor), lev = leverageFor(a, sym), ac = accountOf(s, liveRef.current);
      const comm = commissionFor(s, sym, entry, rate), need = marginUsd(sym, o.lots, entry, rate, lev);
      // MT5 takes the commission at the fill, so it has to fit in the free margin too.
      if (need + comm * o.lots > ac.free) return `Not enough money: this needs ${fmtMoney(need)} margin${comm ? ` + ${fmtMoney(comm * o.lots)} commission` : ""}, free margin is ${fmtMoney(ac.free)}.`;
      openAt(t, entry, s.cursor, rate, lev, () => comm);
    }
    else t.orderPrice = entry;
    patch((x) => ({ ...x, trades: [...x.trades, t] }));
    await refreshLive();
    return null;
  }).then((r) => r ?? null);

  // Resolves true when the change went through.
  const editTrade = (tid: string, fn: (t: Trade, s: Session) => string | void) => enqueue(async () => {
    const s = get(), t0 = s.trades.find((t) => t.id === tid);
    if (!t0) return false;
    const t = structuredClone(t0);
    const err = fn(t, s);
    if (err) { setNotice(err); setLive({ ...liveRef.current }); return false; } // redraw the lines where they were
    setNotice("");
    patch((x) => ({ ...x, trades: x.trades.map((y) => (y.id === tid ? t : y)) }));
    return true;
  });

  // Stops and targets must sit on the losing / winning side of the price they close at.
  const checkLevels = (t: Trade, s: Session) => {
    const buy = t.side === "buy";
    const ref = t.status === "pending" ? t.price : exitPrice(t, liveRef.current.bid[t.symbol], spreadPrice(s, t.symbol, s.cursor));
    if (t.sl != null && (buy ? t.sl >= ref : t.sl <= ref)) return `The stop loss must be ${buy ? "below" : "above"} ${t.status === "pending" ? "the entry" : "the current price"}.`;
    if (t.tp != null && (buy ? t.tp <= ref : t.tp >= ref)) return `The take profit must be ${buy ? "above" : "below"} ${t.status === "pending" ? "the entry" : "the current price"}.`;
  };

  const modify = (tid: string, change: { sl?: number | null; tp?: number | null; price?: number }) => editTrade(tid, (t, s) => {
    Object.assign(t, change);
    if (t.status === "pending" && change.price != null) t.orderPrice = change.price;
    if (t.status === "pending" && change.price != null) {
      const bid = liveRef.current.bid[t.symbol], ask = bid + spreadPrice(s, t.symbol, s.cursor), buy = t.side === "buy";
      const ok = t.type === "limit" ? (buy ? t.price < ask : t.price > bid) : (buy ? t.price > ask : t.price < bid);
      if (!ok) return `That price would fill a ${t.side} ${t.type} at once; use a market order instead.`;
    }
    if (t.status === "pending") t.initialSl = t.sl;
    // A stop added after the entry sets the risk for the R multiple.
    if (t.status === "open" && t.riskUsd == null && t.sl != null) t.riskUsd = Math.abs(pnlUsd(t.symbol, t.price - t.sl, t.lots, liveRef.current.rate[t.symbol] ?? 1));
    return checkLevels(t, s);
  });

  const closeTrade = (tid: string, fraction: number) => editTrade(tid, (t, s) => {
    const bid = liveRef.current.bid[t.symbol];
    if (bid == null || t.status !== "open") return "No price for this symbol yet.";
    let lots = fraction >= 1 ? t.lots : Math.max(0.01, Math.round(t.lots * fraction * 100) / 100);
    if (lots >= t.lots) lots = t.lots;
    realize(t, lots, exitPrice(t, bid, spreadPrice(s, t.symbol, s.cursor)), s.cursor, liveRef.current.rate[t.symbol] ?? 1, s.commission, "manual");
  });

  const breakeven = (tid: string) => editTrade(tid, (t, s) => {
    t.sl = t.price;
    return checkLevels(t, s);
  });

  const cancel = (tid: string) => editTrade(tid, (t) => { t.status = "cancelled"; t.closedAt = get().cursor; });

  const onLineDrag = (line: OrderLine, raw: number) => {
    const price = Number(raw.toFixed(digits(get().symbol)));
    if (line.tradeId === "draft") { setDraftDrag({ kind: line.kind, price, n: Date.now() }); return; }
    const t = get().trades.find((x) => x.id === line.tradeId);
    if (!t) return;
    const key = line.kind === "entry" ? "price" : line.kind;
    setNotice("");
    setMods((all) => {
      const m: Mod = { ...all[t.id], [key]: price };
      if (t[key] === price) delete m[key]; // dragged back to where it is
      const next = { ...all };
      if (Object.keys(m).length) next[t.id] = m; else delete next[t.id];
      return next;
    });
  };

  const confirmMod = async (tid: string) => {
    const m = mods[tid];
    if (m && (await modify(tid, m))) setMods((all) => { const next = { ...all }; delete next[tid]; return next; });
  };
  const cancelMod = (tid: string) => { setNotice(""); setMods((all) => { const next = { ...all }; delete next[tid]; return next; }); };
  const modKeys = useRef({ confirm: () => {}, cancel: () => {} });
  modKeys.current = {
    confirm: () => { for (const tid of Object.keys(mods)) confirmMod(tid); },
    cancel: () => { if (Object.keys(mods).length) { setNotice(""); setMods({}); } },
  };

  // A change waiting for a trade that has closed (or was undone) is dropped.
  useEffect(() => {
    if (!session) return;
    const gone = Object.keys(mods).filter((tid) => !session.trades.some((t) => t.id === tid && isActive(t)));
    if (gone.length) setMods((all) => { const next = { ...all }; for (const tid of gone) delete next[tid]; return next; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.trades]);

  // ---------------------------------------------------------- chart overlays

  useEffect(() => {
    if (!rcRef.current || !ready || !session) return;
    const sym = session.symbol, bid = live.bid[sym], rate = live.rate[sym] ?? 1, spr = spreadPrice(session, sym, session.cursor);
    const lines: OrderLine[] = [];
    // Result at a price, commission included (a pending order's is worked out at its price).
    const money = (t: Trade, px: number) => pnlUsd(sym, t.side === "buy" ? px - t.price : t.price - px, t.lots, rate) - (t.comm ?? commissionFor(session, sym, t.price, rate)) * t.lots;
    for (const t of session.trades) {
      if (t.symbol !== sym || !isActive(t)) continue;
      const color = t.side === "buy" ? "#2962ff" : "#f23645";
      const label = `${t.side.toUpperCase()}${t.status === "pending" ? " " + t.type.toUpperCase() : ""} ${t.lots.toFixed(2)}`;
      const fl = t.status === "open" && bid != null ? floating(t, bid, spr, rate) : null;
      // A level moved but not confirmed: the old one stays grey where it still works.
      const m = mods[t.id] ?? {}, nt = { ...t, ...m };
      const old = (kind: OrderLine["kind"], price: number, text: string) =>
        lines.push({ key: `${t.id}:${kind}:old`, tradeId: t.id, kind, price, color: "#787b86", dashed: true, draggable: false, text });
      if (m.price != null) old("entry", t.price, label);
      if (m.sl != null && t.sl != null) old("sl", t.sl, `SL  ${fmtMoney(money(t, t.sl), true)}`);
      if (m.tp != null && t.tp != null) old("tp", t.tp, `TP  ${fmtMoney(money(t, t.tp), true)}`);
      const wait = (k: keyof Mod) => (m[k] != null ? "  · Confirm?" : "");
      lines.push({ key: t.id + ":entry", tradeId: t.id, kind: "entry", price: nt.price, color, dashed: t.status === "pending", draggable: t.status === "pending", text: (fl == null ? label : `${label}  ${fmtMoney(fl, true)}`) + wait("price") });
      if (nt.sl != null) lines.push({ key: t.id + ":sl", tradeId: t.id, kind: "sl", price: nt.sl, color: "#f23645", dashed: true, draggable: true, text: `SL  ${fmtMoney(money(nt, nt.sl), true)}${wait("sl")}` });
      if (nt.tp != null) lines.push({ key: t.id + ":tp", tradeId: t.id, kind: "tp", price: nt.tp, color: "#089981", dashed: true, draggable: true, text: `TP  ${fmtMoney(money(nt, nt.tp), true)}${wait("tp")}` });
    }
    // The order being set up in the order panel.
    if (draft) {
      const t = { side: draft.side, price: draft.entry, lots: draft.lots } as Trade;
      const color = draft.side === "buy" ? "#2962ff" : "#f23645";
      const label = `${draft.side.toUpperCase()}${draft.type === "market" ? "" : " " + draft.type.toUpperCase()} ${draft.lots ? draft.lots.toFixed(2) : "—"}`;
      lines.push({ key: "draft:entry", tradeId: "draft", kind: "entry", price: draft.entry, color, dashed: true, draggable: true, text: label });
      if (draft.sl != null) lines.push({ key: "draft:sl", tradeId: "draft", kind: "sl", price: draft.sl, color: "#f23645", dashed: true, draggable: true, text: `SL  ${fmtMoney(money(t, draft.sl), true)}` });
      if (draft.tp != null) lines.push({ key: "draft:tp", tradeId: "draft", kind: "tp", price: draft.tp, color: "#089981", dashed: true, draggable: true, text: `TP  ${fmtMoney(money(t, draft.tp), true)}` });
    }
    for (const c of allCharts()) c.setOrderLines(lines);
    const marks: TradeMark[] = session.trades
      .filter((t) => t.symbol === sym && t.status === "closed" && t.closedAt! <= session.cursor)
      .map((t) => ({ id: t.id, side: t.side, win: t.pnl > 0, t0: t.openedAt!, p0: t.price, t1: t.closedAt!, p1: t.closePrice! }));
    for (const c of allCharts()) c.setTradeMarks(marks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, live, ready, draft, active, prefs.split, mods]);

  // ---------------------------------------------------------- journal screenshots

  // Every chart side by side in one JPEG, each with its symbol and timeframe.
  const snapshotAll = async () => {
    const s = get(), list = allCharts();
    const imgs = await Promise.all(list.map((c) => new Promise<HTMLImageElement>((ok, fail) => {
      const im = new Image(); im.onload = () => ok(im); im.onerror = fail; im.src = c.snapshot();
    })));
    const gap = 2, w = imgs.reduce((a, im) => a + im.width, 0) + gap * (imgs.length - 1), h = Math.max(...imgs.map((im) => im.height));
    const k = Math.min(1, 1800 / w), cv = document.createElement("canvas");
    cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    const g = cv.getContext("2d")!;
    g.fillStyle = "#2a2e39"; g.fillRect(0, 0, cv.width, cv.height);
    let x = 0;
    imgs.forEach((im, i) => {
      g.drawImage(im, x * k, 0, im.width * k, im.height * k);
      const label = `${s.symbol} · ${tfOf(s, charts.current.indexOf(list[i]))} · ${fmtDateTime(s.cursor, tz)}`;
      g.font = "600 13px Inter, sans-serif";
      g.fillStyle = "rgba(19,23,34,0.85)"; g.fillRect(x * k + 8, 8, g.measureText(label).width + 16, 24);
      g.fillStyle = "#d1d4dc"; g.fillText(label, x * k + 16, 25);
      x += im.width + gap;
    });
    return cv.toDataURL("image/jpeg", 0.85);
  };

  // A trade that opened or closed within the last step gets a screenshot of the
  // charts, once the order lines and trade marks are drawn.
  const shooting = useRef(false);
  useEffect(() => {
    if (!ready || !session || shooting.current || !rcRef.current) return;
    const win = Math.max(60, TF_SEC[tfOf(session, activeRef.current)]), now = session.cursor;
    const due: [string, ShotKind][] = [];
    for (const t of session.trades) {
      if (!t.shots?.entry && t.openedAt != null && t.openedAt <= now && now - t.openedAt <= win) due.push([t.id, "entry"]);
      if (!t.shots?.exit && t.status === "closed" && t.closedAt != null && t.closedAt <= now && now - t.closedAt <= win) due.push([t.id, "exit"]);
    }
    if (!due.length) return;
    shooting.current = true;
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      try {
        const url = await snapshotAll();
        for (const [tid, kind] of due) await putShot(shotKey(id, tid, kind), url);
        patch((x) => ({
          ...x,
          trades: x.trades.map((t) => {
            const kinds = due.filter(([tid]) => tid === t.id).map(([, k]) => k);
            return kinds.length ? { ...t, shots: { ...t.shots, ...Object.fromEntries(kinds.map((k) => [k, true])) } } : t;
          }),
        }));
      } catch (e) { console.error("screenshot", e); }
      finally { shooting.current = false; }
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, ready]);

  // ---------------------------------------------------------- keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName) || settingsOpen.current) return;
      if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setPlaying(false); step(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); setPlaying(false); stepBack(); }
      else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") modKeys.current.confirm();
      else if (e.key === "Escape") { modKeys.current.cancel(); rcRef.current?.cancelTool(); setTool(null); setMenu(""); setDrawMenu(null); setPicking(false); setPickX(null); setPickConfirm(null); }
      else if (e.key === "Delete" || e.key === "Backspace") rcRef.current?.removeSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeDrawMenu = useCallback(() => setDrawMenu(null), []);

  // While picking a bar: a line follows the crosshair and a click picks the candle under it.
  useEffect(() => {
    const rc = rcRef.current, el = elRefs[activeRef.current].current;
    if (!picking || !rc || !el) return;
    let bar: { timestamp: number } | null = null;
    const off = rc.onCrosshair((x, b) => { bar = b; setPickX(b ? x : null); });
    const click = () => { if (bar) pickBar(bar); };
    el.addEventListener("click", click);
    return () => { off(); el.removeEventListener("click", click); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, active]);

  const groups = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const s of index?.symbols || []) g.set(s.group, [...(g.get(s.group) || []), s.name]);
    return [...g.entries()];
  }, [index]);

  if (!session) {
    return (
      <main style={{ padding: 40, textAlign: "center" }}>
        <p>This session doesn&apos;t exist (maybe it was deleted).</p>
        <Link className="btn primary" href="/dashboard">Back to dashboard</Link>
      </main>
    );
  }

  const ac = accountOf(session, live), a = acct(session);
  const balance = ac.balance, openPnl = ac.equity - ac.balance;
  const summary = <>
    <span>Balance <b>{fmtMoney(ac.balance)}</b></span>
    <span>Equity <b>{fmtMoney(ac.equity)}</b></span>
    <span>Margin <b>{fmtMoney(ac.margin)}</b></span>
    <span>Free margin <b>{fmtMoney(ac.free)}</b></span>
    <span>Margin level <b className={ac.level != null && ac.level <= a.marginCall ? "neg" : ""}>{ac.level == null ? "—" : `${ac.level.toFixed(2)}%`}</b></span>
    {ac.level != null && ac.level <= a.marginCall && <b className="neg">Margin call</b>}
    <span>1:{a.leverage}</span>
  </>;
  const setAcct = (change: Partial<typeof a>) => patch((x) => ({ ...x, account: { ...acct(x), ...change } }));
  const ch = session.challenge, chState = ch ? challengeState(session, ch, ac.balance, ac.equity) : null;
  const badge = ch && chState ? challengeBadge(ch, chState, session.balance0) : null;
  // A passed phase starts the next one as a new session from here.
  const nextPhase = () => {
    if (!ch) return;
    const s = get(), next = NEXT_PHASE[ch.name], nid = uid();
    useSessions.getState().add({
      ...structuredClone(s), id: nid, createdAt: Date.now(), name: `${s.name.replace(/ · Phase \d$/, "")} · ${next.split("· ")[1] ?? next}`,
      startTime: s.cursor, endTime: null, trades: [], adjust: [], challenge: challengeFrom(next),
    });
    router.push(`/session/${nid}`);
  };
  const journalTrade = journalId ? session.trades.find((t) => t.id === journalId) : null;
  const onJournal = (tid: string, change: JournalChange) => patch((x) => ({ ...x, trades: x.trades.map((t) => (t.id === tid ? { ...t, ...change } : t)) }));
  const sym = session.symbol;
  const range = index ? dataRange(sym) : null;
  const goingBack = !!jumpTo && fromDateInput(jumpTo) < session.cursor;
  const activeN = session.trades.filter(isActive).length;

  const toggleOrderPanel = () => {
    const next = !prefs.orderPanel;
    prefs.set({ orderPanel: next });
    if (next && typeof window !== "undefined" && window.innerWidth < 1024) {
      setBottomOpen(false);
    }
  };

  const toggleBottomDetails = () => {
    const next = !bottomOpen;
    setBottomOpen(next);
    if (next && typeof window !== "undefined" && window.innerWidth < 1024) {
      prefs.set({ orderPanel: false });
    }
  };

  const pickTool = (name: string | null) => {
    const rc = rcRef.current;
    if (!rc) return;
    rc.cancelTool();
    setTool(name);
    if (name) rc.startTool(name);
  };
  const rc = rcRef.current, selected = ready && rc ? rc.getDrawing(selId) : null;

  return (
    <div className="ws">
      {/* ---------------- top bar */}
      <div className="ws-top">
        <Link className="btn icon-btn" href="/dashboard" title="Dashboard"><Icon name="back" /></Link>
        <b style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={session.name}>{session.name}</b>
        {ch && chState && badge && (
          <div style={{ position: "relative" }}>
            <button className={`btn sm chal ${badge.cls} ${menu === "chal" ? "on" : ""}`} title={ch.name} onClick={() => setMenu(menu === "chal" ? "" : "chal")}>{badge.text}</button>
            {menu === "chal" && <ChallengePanel c={ch} st={chState} balance0={session.balance0} tz={tz} onNextPhase={nextPhase}
              onRules={(change) => patch((x) => ({ ...x, challenge: x.challenge && { ...x.challenge, ...change } }))} />}
          </div>
        )}
        <span className="div" />
        <select className="input sm" style={{ width: 100 }} value={sym} onChange={(e) => show({ symbol: e.target.value })} aria-label="Symbol">
          {groups.map(([g, list]) => <optgroup key={g} label={g}>{list.map((s) => <option key={s}>{s}</option>)}</optgroup>)}
        </select>
        <span className="div" />
        <div className="mobile-tf-wrap">
          <select className="input sm" style={{ width: 72 }} value={tfOf(session, active)} onChange={(e) => show({ tf: e.target.value as TF })} aria-label="Timeframe">
            {TFS.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
          </select>
        </div>
        <div className="desktop-tf-wrap">
          {TFS.map((tf: TF) => (
            <button key={tf} className={`btn sm ${tfOf(session, active) === tf ? "on" : ""}`} onClick={() => show({ tf })}>{tf}</button>
          ))}
        </div>
        <span className="div" />
        <button className={`btn icon-btn ${prefs.chartType === "candle" ? "on" : ""}`} title="Candles" onClick={() => prefs.set({ chartType: "candle" })}><Icon name="candle" /></button>
        <button className={`btn icon-btn ${prefs.chartType === "line" ? "on" : ""}`} title="Line" onClick={() => prefs.set({ chartType: "line" })}><Icon name="line" /></button>
        <div className="desktop-nav-items">
          <button className={`btn icon-btn ${prefs.split ? "" : "on"}`} title="One chart" onClick={() => prefs.set({ split: false })}><Icon name="layout1" /></button>
          <button className={`btn icon-btn ${prefs.split ? "on" : ""}`} title="Two charts side by side (click a chart to pick its timeframe)" onClick={() => prefs.set({ split: true })}><Icon name="layout2" /></button>
          <div style={{ position: "relative" }}>
            <button className={`btn icon-btn ${menu === "chart" ? "on" : ""}`} title="Chart colours" onClick={() => setMenu(menu === "chart" ? "" : "chart")}><Icon name="gear" /></button>
            {menu === "chart" && <ChartSettings />}
          </div>
          <span className="div" />
          <div style={{ position: "relative" }}>
            <button className={`btn sm ${menu === "ind" ? "on" : ""}`} onClick={() => setMenu(menu === "ind" ? "" : "ind")}>Indicators ▾</button>
            {menu === "ind" && <IndicatorMenu onClose={() => setMenu("")} />}
          </div>
          <span className="div" />
          <select className="input sm" style={{ width: 96 }} value={prefs.tz} onChange={(e) => prefs.set({ tz: e.target.value })} aria-label="Time zone">
            {TZS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
          </select>

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }} className="num">
            <div className="stat"><span>Balance</span><b>{fmtMoney(balance)}</b></div>
            <div className="stat"><span>Equity</span><b>{fmtMoney(balance + openPnl)}</b></div>
            <div className="stat"><span>Open P&amp;L</span><b className={pnlClass(openPnl)}>{fmtMoney(openPnl, true)}</b></div>
            <div style={{ position: "relative" }}>
              <button className={`btn sm ${menu === "session" ? "on" : ""}`} onClick={() => { setConfirmDel(false); setMenu(menu === "session" ? "" : "session"); }}>Session</button>
              {menu === "session" && (
                <div className="pop" style={{ right: 0, width: 260, display: "grid", gap: 10, maxHeight: "calc(100vh - 60px)", overflowY: "auto" }}>
                  <label className="field"><span>Name</span>
                    <input className="input sm" defaultValue={session.name} maxLength={80}
                      onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== session.name) patch((x) => ({ ...x, name: n })); else e.target.value = session.name; }}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                  </label>
                  <label className="field"><span>{sym} spread (pips{a.floatingSpread ? ", quiet hours" : ""})</span>
                    <input className="input sm num" type="number" step="0.1" min="0" value={spreadPips(session, sym)}
                      onChange={(e) => { const v = Number(e.target.value); if (v >= 0) patch((x) => ({ ...x, spreads: { ...x.spreads, [sym]: v } })); }} />
                  </label>
                  <label className="field"><span>Commission ($ per lot, round turn)</span>
                    <input className="input sm num" type="number" step="0.5" min="0" value={session.commission}
                      onChange={(e) => { const v = Number(e.target.value); if (v >= 0) patch((x) => ({ ...x, commission: v })); }} />
                  </label>
                  <label className="field"><span>Default risk per trade (%)</span>
                    <input className="input sm num" type="number" step="0.1" min="0.01" value={session.riskPct}
                      onChange={(e) => { const v = Number(e.target.value); if (v > 0) patch((x) => ({ ...x, riskPct: v })); }} />
                  </label>
                  <label className="field"><span>Account type (margin call / stop out)</span>
                    <select className="input sm" value={a.type} onChange={(e) => { const k = ACCOUNT_TYPES[e.target.value]; patch((x) => ({ ...x, commission: k.commission, account: { ...acct(x), ...accountFor(e.target.value) } })); }}>
                      {Object.entries(ACCOUNT_TYPES).map(([k, v]) => <option key={k} value={k}>{k} ({v.marginCall}% / {v.stopOut}%)</option>)}
                    </select>
                  </label>
                  <label className="field"><span>Leverage</span>
                    <select className="input sm" value={a.leverage} onChange={(e) => setAcct({ leverage: Number(e.target.value) })}>
                      {LEVERAGES.map((l) => <option key={l} value={l}>1:{l}</option>)}
                    </select>
                    {leverageFor(a, sym) < a.leverage && <span className="muted" style={{ fontSize: 12 }}>{sym} uses 1:{leverageFor(a, sym)}</span>}
                  </label>
                  {a.cryptoPct != null && <p className="muted" style={{ margin: 0, fontSize: 12 }}>Crypto commission: {a.cryptoPct}% of the position value. {a.maxLots != null && `At most ${a.maxLots} lots per order.`}</p>}
                  <label className="row-check"><input type="checkbox" checked={a.floatingSpread} onChange={(e) => setAcct({ floatingSpread: e.target.checked })} /> Floating spread (wider at rollover and in Asia)</label>
                  <label className="row-check"><input type="checkbox" checked={a.swaps} onChange={(e) => setAcct({ swaps: e.target.checked })} /> Charge swaps (off = swap-free account)</label>
                  {a.swaps && (
                    <div className="field"><span>{sym} swap, points per lot (long / short)</span>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                        {(["long", "short"] as const).map((k) => (
                          <input key={k} className="input sm num" type="number" step="0.1" aria-label={`Swap ${k}`} value={swapPoints(session, sym)[k]}
                            onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setAcct({ swapPts: { ...a.swapPts, [sym]: { ...swapPoints(session, sym), [k]: v } } }); }} />
                        ))}
                      </div>
                      <button className="btn sm" style={{ justifySelf: "start", padding: 0, color: "var(--muted)" }} onClick={() => { const next = { ...a.swapPts }; delete next[sym]; setAcct({ swapPts: next }); }}>
                        Default ({defaultSwap(sym).long} / {defaultSwap(sym).short})
                      </button>
                    </div>
                  )}
                  <label className="field"><span>Prop firm challenge</span>
                    <select className="input sm" value={ch?.name ?? ""} onChange={(e) => patch((x) => ({ ...x, challenge: e.target.value ? challengeFrom(e.target.value) : undefined }))}>
                      <option value="">None</option>
                      {Object.keys(CHALLENGES).map((k) => <option key={k}>{k}</option>)}
                    </select>
                  </label>
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>Starting balance {fmtMoney(session.balance0)}</p>
                  {confirmDel ? (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <span className="muted" style={{ fontSize: 12, width: "100%" }}>Delete this session, its trades and screenshots? This can&apos;t be undone.</span>
                      <button className="btn outline sm" onClick={() => setConfirmDel(false)}>Keep</button>
                      <button className="btn danger sm" onClick={deleteSession}>Delete for good</button>
                    </div>
                  ) : (
                    <button className="btn danger sm" style={{ justifySelf: "start" }} onClick={() => setConfirmDel(true)}>Delete session…</button>
                  )}
                </div>
              )}
            </div>
            {!prefs.orderPanel && <button className="btn sm primary" style={{ marginLeft: 4 }} onClick={() => prefs.set({ orderPanel: true })}>New order</button>}
            <Link className="btn sm outline" href={`/session/${id}/stats`} style={{ marginLeft: 4 }}><Icon name="chart" /> Analytics</Link>
          </div>
        </div>

        {/* Mobile Navbar More Button */}
        <div className="mobile-nav-toggle">
          <button
            className={`btn sm ${mobileMenuOpen ? "on" : ""}`}
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            title="Options & settings"
          >
            {mobileMenuOpen ? "✕" : "☰ Options"}
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="mobile-menu-drawer">
          <div className="mobile-menu-backdrop" onClick={() => setMobileMenuOpen(false)} />
          <div className="mobile-menu-content">
            <div className="mobile-menu-header">
              <b>Options &amp; Settings</b>
              <button className="btn icon-btn sm" onClick={() => setMobileMenuOpen(false)}>✕</button>
            </div>

            <div className="mobile-menu-stats num">
              <div className="stat-box">
                <span>Balance</span>
                <b>{fmtMoney(balance)}</b>
              </div>
              <div className="stat-box">
                <span>Equity</span>
                <b>{fmtMoney(balance + openPnl)}</b>
              </div>
              <div className="stat-box">
                <span>Open P&amp;L</span>
                <b className={pnlClass(openPnl)}>{fmtMoney(openPnl, true)}</b>
              </div>
              <div className="stat-box">
                <span>Free Margin</span>
                <b>{fmtMoney(ac.free)}</b>
              </div>
            </div>

            <hr className="mobile-menu-divider" />

            <div className="mobile-menu-grid">
              <button
                className="btn sm outline mob-opt-btn"
                onClick={() => { setMobileMenuOpen(false); setMenu("ind"); }}
              >
                <Icon name="chart" />
                <span>Indicators</span>
              </button>

              <button
                className="btn sm outline mob-opt-btn"
                onClick={() => { setMobileMenuOpen(false); setMenu("chart"); }}
              >
                <Icon name="gear" />
                <span>Chart Colours</span>
              </button>

              <div className="mob-opt-field">
                <span className="mob-opt-label">Time Zone:</span>
                <select
                  className="input sm"
                  value={prefs.tz}
                  onChange={(e) => prefs.set({ tz: e.target.value })}
                  aria-label="Time zone"
                >
                  {TZS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
                </select>
              </div>

              <div className="mob-opt-field">
                <span className="mob-opt-label">Chart Split:</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    className={`btn sm icon-btn ${prefs.split ? "" : "on"}`}
                    title="One chart"
                    onClick={() => prefs.set({ split: false })}
                  >
                    <Icon name="layout1" />
                  </button>
                  <button
                    className={`btn sm icon-btn ${prefs.split ? "on" : ""}`}
                    title="Two charts"
                    onClick={() => prefs.set({ split: true })}
                  >
                    <Icon name="layout2" />
                  </button>
                </div>
              </div>

              <button
                className="btn sm outline mob-opt-btn"
                onClick={() => { setMobileMenuOpen(false); setConfirmDel(false); setMenu("session"); }}
              >
                <Icon name="gear" />
                <span>Session Settings</span>
              </button>

              <Link
                className="btn sm outline mob-opt-btn"
                href={`/session/${id}/stats`}
                onClick={() => setMobileMenuOpen(false)}
              >
                <Icon name="chart" />
                <span>Analytics</span>
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- tools | chart | order panel */}
      <div className={`ws-mid ${prefs.orderPanel ? "" : "no-side"}`}>
        <div className={`ws-tools ${mobileToolsOpen ? "open" : ""}`}>
          <div className="mobile-tools-header">
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)" }}>TOOLS</span>
            <button className="btn icon-btn sm" onClick={() => setMobileToolsOpen(false)} title="Close tools">✕</button>
          </div>
          <ToolColumn rc={rc} tool={tool} onTool={(t) => { pickTool(t); if (t) setMobileToolsOpen(false); }} hidden={hidden} onHidden={(on) => { setHidden(on); for (const c of allCharts()) c.setHidden(on); }} />
        </div>

        <div className="ws-chart">
          <div className={`charts ${prefs.split ? "split" : ""}`}>
            {(prefs.split ? [0, 1] : [0]).map((i) => (
              <div key={i} className={`pane ${prefs.split && active === i ? "active" : ""}`} onMouseDownCapture={() => activate(i)}>
                <div ref={elRefs[i]} className="canvas" style={picking ? { cursor: "crosshair" } : undefined} onContextMenu={(e) => { if (drawMenu) e.preventDefault(); }} />
                {prefs.split && <span className="pane-tf">{tfOf(session, i)}</span>}
                {i === active && <>
                  {picking && pickX != null && <div className="pick-line" style={{ left: pickX }} />}
                  {Object.keys(mods).length > 0 && <ModifyBar trades={session.trades} mods={mods} onConfirm={confirmMod} onCancel={cancelMod} />}
                  {rc && selected && !settingsId && <DrawBar rc={rc} d={selected} onText={() => setTextId(selected.id)} onSettings={() => setSettingsId(selected.id)} />}
                  {rc && drawMenu && <DrawMenu rc={rc} {...drawMenu} onSettings={() => setSettingsId(drawMenu.id)} onClose={closeDrawMenu} />}
                  {rc && textId && <TextEdit key={textId} rc={rc} id={textId} onClose={() => setTextId(null)} />}
                </>}
              </div>
            ))}
          </div>
          {rc && settingsId && <DrawingSettings key={settingsId} rc={rc} id={settingsId} tz={tz} onClose={() => setSettingsId(null)} />}
          {(loading > 0 || !ready) && <div className="loading">Loading candles…</div>}
          {ch?.failed && <button className="chal-banner" onClick={() => setMenu("chal")}>Challenge failed: {ch.failed.reason === "daily" ? "daily loss limit" : "maximum loss"} hit on {fmtDateTime(ch.failed.time, tz)}. Step back to try again.</button>}
          <div className="replay-bar">
            <button className={`btn icon-btn mobile-tools-toggle ${mobileToolsOpen ? "on" : ""}`} title="Drawing tools" onClick={() => setMobileToolsOpen(!mobileToolsOpen)}><Icon name="segment" /></button>
            <button className={`btn icon-btn ${picking ? "on" : ""}`} title="Select bar: click a candle to replay from it (Esc to cancel)"
              onClick={() => { setPlaying(false); setPickConfirm(null); rcRef.current?.cancelTool(); setTool(null); setPicking(!picking); setPickX(null); }}><Icon name="selectBar" /></button>
            <button className="btn icon-btn" title="Back one candle (←)" onClick={() => { setPlaying(false); stepBack(); }}><Icon name="stepBack" /></button>
            <button className="btn icon-btn" title="Play / pause (Space)" onClick={() => setPlaying(!playing)}><Icon name={playing ? "pause" : "play"} /></button>
            <button className="btn icon-btn" title="Next candle (→)" onClick={() => { setPlaying(false); step(); }}><Icon name="step" /></button>
            <select className="input sm" style={{ width: 84 }} value={prefs.speed} onChange={(e) => prefs.set({ speed: Number(e.target.value) })} aria-label="Speed">
              {SPEEDS.map((v) => <option key={v} value={v}>{v} / sec</option>)}
            </select>
            <span className="num" style={{ marginLeft: 6, whiteSpace: "nowrap" }}>{fmtDateTime(session.cursor, tz)}</span>
            <div style={{ position: "relative" }}>
              <button className={`btn sm ${menu === "jump" ? "on" : ""}`} onClick={() => { setJumpTo(dateInput(session.cursor + 86400)); setMenu(menu === "jump" ? "" : "jump"); }}>Jump to…</button>
              {menu === "jump" && (
                <div className="pop" style={{ bottom: "calc(100% + 6px)", top: "auto", left: 0, display: "grid", gap: 6, width: 250 }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input className="input sm" type="date" value={jumpTo} min={range ? dateInput(range.from) : undefined} max={range ? dateInput(range.to) : undefined} onChange={(e) => setJumpTo(e.target.value)} />
                    <button className="btn primary sm" onClick={jump}>Go</button>
                  </div>
                  {goingBack && activeN > 0 && (
                    <p className="muted" style={{ margin: 0, fontSize: 12 }}>Going back closes your {activeN} open/pending {activeN === 1 ? "order" : "orders"} at the current price first.</p>
                  )}
                </div>
              )}
            </div>
            {picking && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>Click a candle to replay from it. Esc cancels.</span>}
            {pickConfirm && (
              <span style={{ marginLeft: 8, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ whiteSpace: "nowrap" }}>Undo {pickConfirm.n} {pickConfirm.n === 1 ? "trade" : "trades"} after {fmtDateTime(pickConfirm.bar, tz)}?</span>
                <button className="btn primary sm" onClick={() => { const t = pickConfirm.target; setPickConfirm(null); enqueue(() => goBack(t)); }}>Go back</button>
                <button className="btn outline sm" onClick={() => setPickConfirm(null)}>Cancel</button>
              </span>
            )}
            {notice && !picking && !pickConfirm && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{notice}</span>}
          </div>
        </div>

        {prefs.orderPanel && (
          <div className="ws-side">
            <OrderPanel
              symbol={sym}
              bid={live.bid[sym] ?? null}
              spread={spreadPrice(session, sym, session.cursor)}
              rate={live.rate[sym] ?? 1}
              balance={balance}
              riskPct={session.riskPct}
              commission={commissionFor(session, sym, live.bid[sym] ?? 0, live.rate[sym] ?? 1)}
              drag={draftDrag}
              onDraft={setDraft}
              onPlace={place}
              onHide={() => { setDraft(null); prefs.set({ orderPanel: false }); }}
              onEditSetups={() => setSetupsOpen(true)}
            />
          </div>
        )}
      </div>

      <div className="mobile-action-bar">
        <button
          className={`btn sm ${prefs.orderPanel ? "primary on" : "primary"} mob-act-btn mob-act-order`}
          onClick={toggleOrderPanel}
          title="Toggle Order Placement Panel"
        >
          <Icon name="priceLine" />
          <span>{prefs.orderPanel ? "✕ Hide Order" : "⚡ Place Order"}</span>
        </button>
        <button
          className={`btn sm ${bottomOpen ? "on" : "outline"} mob-act-btn mob-act-details`}
          onClick={toggleBottomDetails}
          title="Toggle Order & Position Details"
        >
          <Icon name="chart" />
          <span>{bottomOpen ? "▾ Hide Details" : `▴ Order Details (${session.trades.length})`}</span>
        </button>
      </div>

      <TradesPanel
        trades={session.trades}
        bid={live.bid}
        rate={live.rate}
        spreadOf={(sy) => spreadPrice(session, sy, session.cursor)}
        tz={tz}
        onClose={closeTrade}
        onBreakeven={breakeven}
        onCancel={cancel}
        onModify={modify}
        onNote={(tid, change) => patch((x) => ({ ...x, trades: x.trades.map((t) => (t.id === tid ? { ...t, ...change } : t)) }))}
        onSelectSymbol={(s) => s !== sym && show({ symbol: s })}
        onJournal={setJournalId}
        summary={summary}
        open={bottomOpen}
        onToggleOpen={setBottomOpen}
      />
      {journalTrade && <TradeJournal sid={id} t={journalTrade} tz={tz} onChange={(c) => onJournal(journalTrade.id, c)} onClose={() => setJournalId(null)} />}
      {setupsOpen && <SetupsDialog onClose={() => setSetupsOpen(false)} />}
    </div>
  );
}

// Moved levels waiting for Confirm, one row per trade (Enter confirms all, Esc cancels).
function ModifyBar({ trades, mods, onConfirm, onCancel }: { trades: Trade[]; mods: Record<string, Mod>; onConfirm: (tid: string) => void; onCancel: (tid: string) => void }) {
  return (
    <div className="mod-bar">
      {Object.entries(mods).map(([tid, m]) => {
        const t = trades.find((x) => x.id === tid);
        if (!t) return null;
        const d = digits(t.symbol), px = (v: number | null | undefined) => (v == null ? "Not set" : v.toFixed(d));
        const row = (name: string, from: number | null | undefined, to: number | null | undefined) => (
          <span className="mod-chg">{name} <s>{px(from)}</s> → <b>{px(to)}</b></span>
        );
        return (
          <div key={tid} className="mod-row">
            <span className={`mod-side ${t.side}`}>{t.side.toUpperCase()} {t.lots.toFixed(2)} {t.symbol}</span>
            {m.price != null && row("Entry", t.price, m.price)}
            {"sl" in m && row("SL", t.sl, m.sl)}
            {"tp" in m && row("TP", t.tp, m.tp)}
            <button className="btn primary sm" onClick={() => onConfirm(tid)}>Confirm</button>
            <button className="btn outline sm" onClick={() => onCancel(tid)}>Cancel</button>
          </div>
        );
      })}
    </div>
  );
}
