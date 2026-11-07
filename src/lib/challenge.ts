// Prop firm challenge mode: daily loss limit, maximum loss and profit target,
// like FundingPips / FTMO evaluations. The trading day starts at 17:00 New
// York (midnight on the broker's server); the daily limit counts from the
// balance at that time. A breach is checked on every 1-minute candle in
// Workspace's advance(), which then closes everything.

import { swapOf } from "./broker";
import { nyDst } from "./market";
import type { Challenge, Session, Trade } from "./types";

type Rules = Omit<Challenge, "name" | "failed">;
// Published rules as of 2025-26 (they change; every field can be edited per session).
export const CHALLENGES: Record<string, Rules> = {
  "FundingPips 2-Step · Phase 1": { target: 8, daily: 5, max: 10, trailing: false, minDays: 3 },
  "FundingPips 2-Step · Phase 2": { target: 5, daily: 5, max: 10, trailing: false, minDays: 3 },
  "FundingPips 1-Step": { target: 10, daily: 3, max: 6, trailing: false, minDays: 3 },
  "FundingPips Zero": { target: null, daily: 3, max: 5, trailing: true, minDays: 7 },
  "FTMO · Challenge": { target: 10, daily: 5, max: 10, trailing: false, minDays: 4 },
  "FTMO · Verification": { target: 5, daily: 5, max: 10, trailing: false, minDays: 4 },
  Custom: { target: 10, daily: 5, max: 10, trailing: false, minDays: 0 },
};
// The phase that follows a passed one.
export const NEXT_PHASE: Record<string, string> = {
  "FundingPips 2-Step · Phase 1": "FundingPips 2-Step · Phase 2",
  "FTMO · Challenge": "FTMO · Verification",
};
// The challenge that goes with a FundingPips account type.
export const CHALLENGE_FOR: Record<string, string> = {
  "FundingPips 2-Step": "FundingPips 2-Step · Phase 1",
  "FundingPips 1-Step": "FundingPips 1-Step",
  "FundingPips Zero": "FundingPips Zero",
};
export const challengeFrom = (name: string): Challenge => ({ name, ...CHALLENGES[name] });

// Start (17:00 New York) of the trading day that holds time t (seconds).
export function dayStart(t: number) {
  const d = Math.floor(t / 86400);
  let r = d * 86400 + (nyDst(d * 86400 + 43200) ? 21 : 22) * 3600;
  if (r > t) r = (d - 1) * 86400 + (nyDst((d - 1) * 86400 + 43200) ? 21 : 22) * 3600;
  return r;
}

// Every change to the balance in time order: MT5 takes the commission at the
// fill, each close adds its result (whose commission was already taken), swap
// arrives when the trade closes, and negative balance top-ups.
function ledger(s: Session, trades: Trade[]) {
  const out: { time: number; usd: number }[] = [...(s.adjust || [])];
  for (const t of trades) {
    if (t.comm != null && t.openedAt != null) out.push({ time: t.openedAt, usd: -t.comm * t.initialLots });
    for (const c of t.closes) out.push({ time: c.time, usd: c.pnl + (t.comm ?? 0) * c.lots });
    if (t.status === "closed" && t.closedAt != null && t.swaps?.length) out.push({ time: t.closedAt, usd: swapOf(t) });
  }
  return out.sort((a, b) => a.time - b.time);
}

// Balance at time T.
export const balanceAt = (s: Session, trades: Trade[], T: number) =>
  ledger(s, trades).reduce((b, x) => (x.time <= T ? b + x.usd : b), s.balance0);

// Highest balance up to T (for a trailing max loss).
function peakBalance(s: Session, trades: Trade[], T: number) {
  let b = s.balance0, peak = b;
  for (const x of ledger(s, trades)) { if (x.time > T) break; b += x.usd; peak = Math.max(peak, b); }
  return peak;
}

// Equity must stay above both floors at time t.
export function floors(s: Session, c: Challenge, trades: Trade[], t: number) {
  const day = dayStart(t), dayBalance = balanceAt(s, trades, day);
  const maxAmt = (c.max / 100) * s.balance0;
  return {
    day,
    dayBalance,
    daily: dayBalance - (c.daily / 100) * s.balance0,
    max: c.trailing ? Math.min(s.balance0, peakBalance(s, trades, t) - maxAmt) : s.balance0 - maxAmt,
  };
}

// Days with at least one trade opened.
export const tradingDays = (trades: Trade[]) => new Set(trades.filter((t) => t.openedAt != null).map((t) => dayStart(t.openedAt!))).size;

export type ChallengeState = ReturnType<typeof challengeState>;
// Where the challenge stands now, given the current balance and equity.
export function challengeState(s: Session, c: Challenge, balance: number, equity: number) {
  const f = floors(s, c, s.trades, s.cursor);
  const days = tradingDays(s.trades);
  const profit = balance - s.balance0, targetUsd = c.target != null ? (c.target / 100) * s.balance0 : null;
  const anyOpen = s.trades.some((t) => t.status === "open");
  const passed = !c.failed && targetUsd != null && profit >= targetUsd && days >= c.minDays && !anyOpen;
  return {
    ...f,
    days,
    profit,
    targetUsd,
    passed,
    // Target reached but days or open trades still missing.
    targetHit: targetUsd != null && profit >= targetUsd,
    dailyLeft: equity - f.daily,
    maxLeft: equity - f.max,
    dailyUsd: (c.daily / 100) * s.balance0,
    maxUsd: (c.max / 100) * s.balance0,
  };
}
