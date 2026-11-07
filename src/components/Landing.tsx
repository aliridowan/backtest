"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getIndex, type MarketIndex } from "@/lib/market";
import { chartTz, usePrefs } from "@/lib/store";
import { fmtDay } from "@/lib/format";
import { Logo } from "./brand";

// ------------------------------------------------------------ hero chart

// A made-up market that replays candle by candle: a long trade is taken at
// candle ENTRY and runs into its target. Same candles on every load.
const N = 56, ENTRY = 34;
function heroCandles() {
  let seed = 7, p = 100;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out: { o: number; h: number; l: number; c: number }[] = [];
  for (let i = 0; i < N; i++) {
    // Down into a level, a base, then a trend up after the entry.
    const drift = i < 22 ? -0.35 : i < ENTRY ? 0.02 : 0.42;
    const o = p, c = o + drift + (rnd() - 0.5) * 1.6;
    out.push({ o, c, h: Math.max(o, c) + rnd() * 0.8, l: Math.min(o, c) - rnd() * 0.8 });
    p = c;
  }
  return out;
}

function HeroChart() {
  const bars = useMemo(heroCandles, []);
  const W = 640, H = 360, P = 16, AX = 52;
  const lo = Math.min(...bars.map((b) => b.l)) - 1, hi = Math.max(...bars.map((b) => b.h)) + 1;
  const y = (v: number) => P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P);
  const step = (W - AX - P) / N, x = (i: number) => P + i * step + step / 2;
  const entry = bars[ENTRY].c, sl = entry - 2.6, tp = entry + 7.8;
  const delay = (i: number) => ({ animationDelay: `${i * 55}ms` });
  const done = N * 55;
  return (
    <svg className="hero-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="A chart replaying candle by candle, with a long trade that reaches its target">
      <defs>
        <linearGradient id="hz-tp" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#089981" stopOpacity="0.28" /><stop offset="1" stopColor="#089981" stopOpacity="0.08" /></linearGradient>
        <linearGradient id="hz-sl" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#f23645" stopOpacity="0.1" /><stop offset="1" stopColor="#f23645" stopOpacity="0.26" /></linearGradient>
      </defs>
      {[0.2, 0.4, 0.6, 0.8].map((f) => <line key={f} x1={P} x2={W - AX} y1={P + f * (H - 2 * P)} y2={P + f * (H - 2 * P)} stroke="#2a2e39" strokeDasharray="2 4" />)}
      {[0.2, 0.4, 0.6, 0.8].map((f) => <text key={f} x={W - AX + 8} y={P + f * (H - 2 * P) + 4} fill="#5d606b" fontSize="11">{(hi - f * (hi - lo)).toFixed(2)}</text>)}
      {/* the long position: target and stop zones */}
      <g className="hz-fade" style={{ animationDelay: `${ENTRY * 55}ms` }}>
        <rect x={x(ENTRY)} y={y(tp)} width={W - AX - x(ENTRY) - 6} height={y(entry) - y(tp)} fill="url(#hz-tp)" />
        <rect x={x(ENTRY)} y={y(entry)} width={W - AX - x(ENTRY) - 6} height={y(sl) - y(entry)} fill="url(#hz-sl)" />
        <line x1={x(ENTRY)} x2={W - AX - 6} y1={y(entry)} y2={y(entry)} stroke="#2962ff" strokeWidth="1.5" />
        <rect x={W - AX - 98} y={y(entry) - 10} width="86" height="20" rx="3" fill="#2962ff" />
        <text x={W - AX - 90} y={y(entry) + 4} fill="#fff" fontSize="11" fontWeight="600">BUY 1.00 lot</text>
      </g>
      {bars.map((b, i) => {
        const up = b.c >= b.o, col = up ? "#089981" : "#f23645";
        return (
          <g key={i} className="hz-bar" style={delay(i)}>
            <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} stroke={col} strokeWidth="1.2" />
            <rect x={x(i) - step * 0.32} y={y(Math.max(b.o, b.c))} width={step * 0.64} height={Math.max(1.5, Math.abs(y(b.o) - y(b.c)))} fill={col} rx="1" />
          </g>
        );
      })}
      <g className="hz-fade" style={{ animationDelay: `${done}ms` }}>
        <rect x={x(ENTRY) + 8} y={y(tp) + 8} width="144" height="26" rx="6" fill="#089981" />
        <text x={x(ENTRY) + 80} y={y(tp) + 25} fill="#fff" fontSize="12" fontWeight="700" textAnchor="middle">TP hit · +3.0R</text>
      </g>
    </svg>
  );
}

// ------------------------------------------------------------ content

const FEATURES: [string, string, string][] = [
  ["M4 18h4V9H4zm6 0h4V5h-4zm6 0h4v-6h-4z", "Candle-by-candle replay", "Every timeframe from M1 to monthly, two charts side by side, step back or jump to any date. No peeking at the future."],
  ["M3 12h4l3-8 4 16 3-8h4", "A broker that behaves like one", "Spreads that widen at rollover, commission, swap, margin and stop out, checked on every 1-minute candle."],
  ["M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z", "Prop firm challenge mode", "FundingPips and FTMO rules: daily loss, max loss and profit target. Break a rule and the account fails, like the real thing."],
  ["M5 4h11l3 3v13H5zM8 10h8M8 14h8M8 18h5", "Trade journal", "Screenshots at entry and exit, the setup you traded, its checklist and your notes, saved with every trade."],
  ["M4 20V10m6 10V4m6 16v-7m6 7V8", "Analytics that teach", "Win rate per setup, per checklist, per hour and day, equity curve, drawdown, R multiples and CSV export."],
  ["M4 6h16M4 12h10M4 18h7M17 15l3 3-3 3", "TradingView-style drawing", "Trend lines, Fib, rectangles, long/short tools, session boxes and EMAs, with templates you can save and reuse."],
];

const STEPS: [string, string][] = [
  ["Pick a market and a day", "Any of the forex pairs, gold, oil, the Dow, Nasdaq or bitcoin, from any date in the data. Add a challenge if you're preparing for one."],
  ["Trade it candle by candle", "Play, pause or step one bar at a time. Place market and pending orders, drag SL and TP, and let the simulated broker fill them."],
  ["Learn from the numbers", "Every trade is journaled with screenshots. Analytics show which setups, hours and checklists actually make money."],
];

// ------------------------------------------------------------ page

export default function Landing() {
  const tz = chartTz(usePrefs((p) => p.tz));
  const [index, setIndex] = useState<MarketIndex | null>(null);
  useEffect(() => { getIndex().then(setIndex, () => {}); }, []);

  const lastData = index ? Math.max(...index.symbols.map((s) => s.tfs.M1[s.tfs.M1.length - 1]?.to ?? 0)) : null;
  const firstYear = index ? new Date(Math.min(...index.symbols.map((s) => s.tfs.M1[0]?.from ?? Infinity)) * 1000).getUTCFullYear() : null;
  const groups = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const s of index?.symbols || []) g.set(s.group, [...(g.get(s.group) || []), s.name]);
    return [...g.entries()];
  }, [index]);

  return (
    <div className="home">
      <nav className="home-nav">
        <Link href="/" className="brand"><Logo /> BacktestMind</Link>
        <div className="nav-links">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#markets">Markets</a>
        </div>
        <Link className="btn primary" href="/dashboard">Dashboard →</Link>
      </nav>

      <header className="hero">
        <div className="hero-copy">
          <span className="eyebrow"><i /> {index ? `${index.symbols.length} markets` : "Forex, gold, oil, indices, crypto"}{lastData ? ` · data to ${fmtDay(lastData, tz)}` : ""}</span>
          <h1>Practise the market<br /><span>before it costs you.</span></h1>
          <p>Replay any day candle by candle and trade it on a simulated MT5 account, with prop firm rules if you want them. Journal every trade, then let the numbers show what works.</p>
          <div className="hero-cta">
            <Link className="btn primary lg" href="/dashboard">Open dashboard</Link>
            <Link className="btn outline lg" href="/dashboard?new=1">Start a backtest</Link>
          </div>
          <div className="hero-stats num">
            <div><b>{index ? index.symbols.length : "—"}</b><span>markets</span></div>
            <div><b>{firstYear ?? "—"}</b><span>data from</span></div>
            <div><b>1-min</b><span>fills and stops</span></div>
            <div><b>9</b><span>timeframes</span></div>
          </div>
        </div>
        <div className="hero-visual">
          <div className="hero-card">
            <div className="hero-card-top"><span className="dot r" /><span className="dot y" /><span className="dot g" /><b>USOIL · M15</b><span className="muted">Replay</span></div>
            <HeroChart />
          </div>
        </div>
      </header>

      <section id="features" className="land-section">
        <div className="section-head">
          <span className="kicker">Features</span>
          <h2>Everything a serious backtest needs</h2>
          <p>Built to feel like your real platform, so the habits you build here carry over to live trading.</p>
        </div>
        <div className="features">
          {FEATURES.map(([d, title, text]) => (
            <div key={title} className="feature">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="land-section">
        <div className="section-head">
          <span className="kicker">How it works</span>
          <h2>From idea to evidence in three steps</h2>
        </div>
        <ol className="steps">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="step">
              <span className="step-n">{i + 1}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="markets" className="land-section">
        <div className="section-head">
          <span className="kicker">Markets</span>
          <h2>1-minute data, every timeframe built from it</h2>
          <p>{lastData ? `Updated to ${fmtDay(lastData, tz)}.` : "Forex, metals, energies, indices and crypto."} Spreads, swaps and leverage follow Exness and FundingPips account types.</p>
        </div>
        <div className="market-groups">
          {groups.map(([g, list]) => (
            <div key={g} className="market-group">
              <h3>{g} <span className="muted">{list.length}</span></h3>
              <div className="market-list">{list.map((s) => <span key={s} className="chip">{s}</span>)}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="land-cta">
        <h2>Your next hundred trades, before the market charges for them.</h2>
        <p>Sessions, journals and screenshots stay in this browser. Nothing to install.</p>
        <div className="hero-cta" style={{ justifyContent: "center" }}>
          <Link className="btn primary lg" href="/dashboard">Open dashboard</Link>
          <Link className="btn outline lg" href="/dashboard?new=1">Start a backtest</Link>
        </div>
      </section>

      <footer className="land-foot">
        <Link href="/" className="brand"><Logo /> BacktestMind</Link>
        <span className="muted">Historical data for practice only. Past results don&apos;t guarantee future ones.</span>
      </footer>
    </div>
  );
}
