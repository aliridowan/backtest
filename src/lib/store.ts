import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TF } from "./market";
import type { Session } from "./types";

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

type SessionsState = {
  sessions: Record<string, Session>;
  add: (s: Session) => void;
  update: (id: string, fn: (s: Session) => Session) => void;
  remove: (id: string) => void;
  replaceAll: (all: Record<string, Session>) => void;
};

// Every backtest session, kept in this browser (localStorage "bm.sessions").
export const useSessions = create<SessionsState>()(
  persist(
    (set) => ({
      sessions: {},
      add: (s) => set((st) => ({ sessions: { ...st.sessions, [s.id]: s } })),
      update: (id, fn) => set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } } : st)),
      remove: (id) => set((st) => { const next = { ...st.sessions }; delete next[id]; return { sessions: next }; }),
      replaceAll: (all) => set({ sessions: all }),
    }),
    { name: "bm.sessions", version: 1 },
  ),
);

export type CandleColors = { bg: string; up: string; down: string; upBorder: string; downBorder: string; upWick: string; downWick: string; line: string };
export const BULL = "#089981", BEAR = "#f23645";
export const CANDLE_DEFAULT: CandleColors = { bg: "#131722", up: BULL, down: BEAR, upBorder: BULL, downBorder: BEAR, upWick: BULL, downWick: BEAR, line: "#d1d4dc" };

// A market session drawn as a box (M1 to H1); times are local to `tz`, so summer time is handled.
export type MarketSession = { name: string; tz: string; start: string; end: string; color: string; on: boolean };
export const DEFAULT_SESSIONS: MarketSession[] = [
  { name: "Sydney", tz: "Australia/Sydney", start: "07:00", end: "16:00", color: "#e6b800", on: true },
  { name: "Tokyo", tz: "Asia/Tokyo", start: "09:00", end: "18:00", color: "#f23645", on: true },
  { name: "London", tz: "Europe/London", start: "08:00", end: "17:00", color: "#2962ff", on: true },
  { name: "New York", tz: "America/New_York", start: "08:00", end: "17:00", color: "#089981", on: true },
];

// A strategy you trade, with the checklist to tick before taking it.
export type Setup = { name: string; checklist: string[] };
export const DEFAULT_SETUPS: Setup[] = [
  { name: "Trend pullback", checklist: ["Higher timeframe trend agrees", "Price at a key level", "Confirmation candle closed", "Risk:reward at least 1:2"] },
  { name: "Breakout", checklist: ["Clear range or level", "Candle closed outside it", "During London or New York", "Stop beyond the range"] },
];

type Prefs = {
  tz: string; // "" = this computer's
  chartType: "candle" | "line";
  colors: Partial<CandleColors>;
  ema: boolean;
  emaPeriods: number[];
  sessions: boolean;
  sessionList: MarketSession[];
  speed: number; // candles per second while playing
  magnet: boolean;
  lastTf: TF;
  orderPanel: boolean; // the order panel on the right is shown
  split: boolean; // two charts side by side (the second one's timeframe is the session's tf2)
  toolStyle: Record<string, Record<string, unknown>>; // last style used per drawing tool
  templates: Record<string, Record<string, Record<string, unknown>>>; // tool -> template name -> style
  templateDefault: Record<string, string>; // tool -> its default template's name
  setups: Setup[]; // trade journal strategies
  set: (p: Partial<Omit<Prefs, "set">>) => void;
};

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      tz: "", chartType: "candle", colors: {}, ema: false, emaPeriods: [20, 50, 200], sessions: true, sessionList: DEFAULT_SESSIONS, speed: 2, magnet: true, lastTf: "H1", orderPanel: true, split: false, toolStyle: {}, templates: {}, templateDefault: {}, setups: DEFAULT_SETUPS,
      set: (p) => set(p),
    }),
    {
      name: "bm.prefs", version: 2,
      // v1 had one "Asia" session; it is now Sydney and Tokyo (London / New York keep their times, new colours).
      migrate: (old, v) => {
        const p = old as Prefs;
        if (v < 2 && p?.sessionList) {
          const kept = p.sessionList.filter((s) => s.name !== "Asia");
          p.sessionList = DEFAULT_SESSIONS.map((d) => {
            const k = kept.find((s) => s.name === d.name);
            return k ? { ...d, start: k.start, end: k.end, on: k.on } : d;
          });
        }
        return p;
      },
    },
  ),
);

export const chartTz = (tz: string) => tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
