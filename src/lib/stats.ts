import { netOf, rOf } from "./broker";
import type { Setup } from "./store";
import type { Session, Trade } from "./types";

export type Stats = ReturnType<typeof computeStats>;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function group(trades: Trade[], key: (t: Trade) => string, order?: string[]) {
  const m = new Map<string, { n: number; wins: number; pnl: number }>();
  for (const k of order || []) m.set(k, { n: 0, wins: 0, pnl: 0 });
  for (const t of trades) {
    const k = key(t);
    const g = m.get(k) || { n: 0, wins: 0, pnl: 0 };
    g.n++; g.pnl += netOf(t); if (netOf(t) > 0) g.wins++;
    m.set(k, g);
  }
  return [...m.entries()].map(([name, g]) => ({ name, ...g }));
}

export function closedTrades(s: Session) {
  return s.trades.filter((t) => t.status === "closed").sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
}

// Every rule of the trade's setup ticked (a deleted setup: judged by what was ticked).
const allTicked = (t: Trade, setups: Setup[]) => {
  const rules = setups.find((x) => x.name === t.setup)?.checklist;
  return rules ? rules.every((r) => t.checks?.includes(r)) : true;
};

export function computeStats(s: Session, tz: string, setups: Setup[] = []) {
  const trades = closedTrades(s);
  const wins = trades.filter((t) => netOf(t) > 0), losses = trades.filter((t) => netOf(t) <= 0);
  const grossWin = wins.reduce((a, t) => a + netOf(t), 0), grossLoss = -losses.reduce((a, t) => a + netOf(t), 0);
  const net = grossWin - grossLoss;

  // Equity after each closed trade, and the deepest fall from a high.
  let eq = s.balance0, peak = s.balance0, maxDd = 0, maxDdPct = 0;
  const curve = [{ time: s.startTime, equity: eq }];
  for (const t of trades) {
    eq += netOf(t);
    curve.push({ time: t.closedAt!, equity: eq });
    peak = Math.max(peak, eq);
    if (peak - eq > maxDd) { maxDd = peak - eq; maxDdPct = (maxDd / peak) * 100; }
  }

  let streakW = 0, streakL = 0, curW = 0, curL = 0;
  for (const t of trades) {
    if (netOf(t) > 0) { curW++; curL = 0; } else { curL++; curW = 0; }
    streakW = Math.max(streakW, curW); streakL = Math.max(streakL, curL);
  }

  const rs = trades.map(rOf).filter((r): r is number => r != null);
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", hourCycle: "h23" });
  const parts = (t: number) => { const p: Record<string, string> = {}; for (const x of fmt.formatToParts(t * 1000)) p[x.type] = x.value; return p; };
  const holdMin = trades.map((t) => ((t.closedAt ?? 0) - (t.openedAt ?? 0)) / 60);

  return {
    trades,
    count: trades.length,
    open: s.trades.filter((t) => t.status === "open").length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    net,
    returnPct: (net / s.balance0) * 100,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancy: trades.length ? net / trades.length : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    avgR: rs.length ? rs.reduce((a, r) => a + r, 0) / rs.length : null,
    totalR: rs.reduce((a, r) => a + r, 0),
    best: trades.reduce((a, t) => Math.max(a, netOf(t)), 0),
    worst: trades.reduce((a, t) => Math.min(a, netOf(t)), 0),
    maxDd, maxDdPct, streakW, streakL,
    avgHoldMin: holdMin.length ? holdMin.reduce((a, b) => a + b, 0) / holdMin.length : 0,
    curve,
    bySide: group(trades, (t) => (t.side === "buy" ? "Long" : "Short"), ["Long", "Short"]),
    bySymbol: group(trades, (t) => t.symbol),
    byDay: group(trades, (t) => parts(t.openedAt!).weekday, DAYS.slice(1, 6)),
    byHour: group(trades, (t) => parts(t.openedAt!).hour + ":00").sort((a, b) => a.name.localeCompare(b.name)),
    bySetup: group(trades.filter((t) => t.setup), (t) => t.setup!),
    byChecklist: group(trades.filter((t) => t.setup), (t) => (allTicked(t, setups) ? "Every rule ticked" : "Rules missed"), ["Every rule ticked", "Rules missed"]),
    byTag: group(trades.flatMap((t) => (t.tags.length ? t.tags.map((tag) => ({ ...t, tags: [tag] })) : [])), (t) => t.tags[0]),
  };
}
