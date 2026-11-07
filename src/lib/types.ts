import type { TF } from "./market";

export type Side = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop";
export type Status = "pending" | "open" | "closed" | "cancelled";
export type CloseReason = "sl" | "tp" | "manual" | "stopout" | "margin" | "breach"; // margin: a pending order cancelled for lack of free margin; breach: a challenge rule was broken

// One piece of a position that was closed (a partial close or the final one).
export type Fill = { time: number; lots: number; price: number; pnl: number };

export type Trade = {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  status: Status;
  lots: number; // still open
  initialLots: number;
  price: number; // pending: the order price; open/closed: the fill price
  orderPrice?: number; // a pending order's price (the fill can differ after a gap), for stepping back
  sl: number | null;
  tp: number | null;
  initialSl: number | null; // for the R multiple, even after moving the stop
  createdAt: number; // seconds, replay time
  openedAt?: number;
  closedAt?: number;
  closePrice?: number;
  reason?: CloseReason;
  closes: Fill[];
  pnl: number; // realised USD after commission (swap is kept apart in `swaps`)
  comm?: number; // commission, USD per lot round turn, fixed when the order fills (older trades: the session's)
  swaps?: { time: number; usd: number }[]; // swap charged at each rollover while open
  margin?: number; // USD margin held for the whole initialLots
  riskUsd: number | null; // money lost at the first stop, null without a stop
  note: string;
  tags: string[];
  setup?: string; // the strategy it was taken with (prefs.setups)
  checks?: string[]; // the setup's checklist items that were ticked
  shots?: { entry?: boolean; exit?: boolean }; // chart screenshots kept in IndexedDB (shots.ts)
};

// Result of a long/short position tool, worked out on the 1-minute candles up to the replay cursor.
export type PosResult = { s: "pending" | "open" | "win" | "loss"; r?: number; fill?: number; exit?: number };

export type Drawing = {
  id: string;
  name: string;
  points: { timestamp: number; value: number }[];
  style?: Record<string, unknown>; // tool options (colour, width, extend…); missing ones use the tool's defaults
  text?: string;
  lock?: boolean;
  z?: number;
  pos?: { from: number; checked: number; res: PosResult }; // long/short position: from / checked are replay seconds
};

// Broker rules, modelled on Exness (and FundingPips' MT5 accounts).
export type Account = {
  type: string; // "Standard", "Pro", "Raw Spread", "Zero", "FundingPips 2-Step"…
  leverage: number; // 1:x
  marginCall: number; // % margin level that warns
  stopOut: number; // % margin level that closes positions (the most losing first)
  swaps: boolean; // false = swap-free account
  floatingSpread: boolean; // spreads widen at rollover and in the Asian session
  swapPts: Record<string, { long: number; short: number }>; // points per lot per night, overrides the default
  levCaps: Record<string, number>; // lower leverage for some symbols (FundingPips: gold 1:30)
  cryptoPct: number | null; // crypto commission as % of the position value, round turn (null: $ per lot like forex)
  maxLots: number | null; // largest order
  raw: boolean; // raw spreads (commission accounts)
  commFree: string[]; // symbols with no commission (FundingPips: oil)
};

export const REASONS: Record<CloseReason, string> = { sl: "stop loss", tp: "take profit", manual: "closed", stopout: "stop out", margin: "no margin", breach: "rule breach" };

export type Session = {
  id: string;
  name: string;
  createdAt: number; // real time, ms
  usedAt?: number; // real time (ms) it was last opened, for "Continue" on the dashboard
  symbol: string; // symbol on the chart
  tf: TF;
  tf2?: TF; // the second chart in the two-chart layout
  startTime: number; // replay seconds
  endTime: number | null;
  cursor: number; // replay "now", seconds
  balance0: number;
  riskPct: number;
  commission: number; // USD per lot, round turn
  spreads: Record<string, number>; // pips, overrides the default
  account?: Partial<Account>;
  adjust?: { time: number; usd: number }[]; // negative balance protection top-ups // missing in older sessions: Exness Standard defaults
  trades: Trade[];
  drawings: Record<string, Drawing[]>;
  challenge?: Challenge; // prop firm rules this session is held to
};

// Prop firm challenge rules; amounts are % of the starting balance.
export type Challenge = {
  name: string; // "FundingPips 2-Step · Phase 1"…
  target: number | null; // profit target, null = none (instant funding)
  daily: number; // daily loss limit, from the balance at the start of the day (17:00 New York)
  max: number; // maximum loss
  trailing: boolean; // the max loss follows the highest balance up (until it reaches the starting balance)
  minDays: number; // trading days needed before the target counts
  failed?: { time: number; reason: "daily" | "max"; equity: number };
};
