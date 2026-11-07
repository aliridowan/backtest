"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { netOf, rOf, swapOf } from "@/lib/broker";
import { digits } from "@/lib/instruments";
import { computeStats } from "@/lib/stats";
import { chartTz, usePrefs, useSessions } from "@/lib/store";
import { fmtDateTime, fmtDay, fmtDuration, fmtMoney, fmtPct, fmtR, pnlClass } from "@/lib/format";
import { REASONS, type Session } from "@/lib/types";
import { TradeJournal } from "./Journal";
import { Icon } from "./icons";

function EquityCurve({ curve, start }: { curve: { time: number; equity: number }[]; start: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000, H = 260, P = { l: 64, r: 12, t: 12, b: 24 };
  const ys = curve.map((c) => c.equity);
  let lo = Math.min(...ys, start), hi = Math.max(...ys, start);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const n = Math.max(1, curve.length - 1);
  const x = (i: number) => P.l + (i / n) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
  const path = curve.map((c, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(c.equity).toFixed(1)}`).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo));
  const last = curve[curve.length - 1].equity;
  const color = last >= start ? "var(--pos)" : "var(--neg)";
  const h = hover != null ? curve[hover] : null;

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - P.l) / (W - P.l - P.r)) * n);
          setHover(i >= 0 && i < curve.length ? i : null);
        }}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={P.l - 8} y={y(v)} fill="var(--muted)" fontSize="11" textAnchor="end" dominantBaseline="middle">{Math.round(v).toLocaleString("en-US")}</text>
          </g>
        ))}
        <line x1={P.l} x2={W - P.r} y1={y(start)} y2={y(start)} stroke="var(--muted)" strokeDasharray="4 4" strokeWidth="1" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {h && hover != null && <circle cx={x(hover)} cy={y(h.equity)} r="4" fill={color} />}
        <text x={P.l} y={H - 6} fill="var(--muted)" fontSize="11">Start</text>
        <text x={W - P.r} y={H - 6} fill="var(--muted)" fontSize="11" textAnchor="end">Trade {curve.length - 1}</text>
      </svg>
      {h && hover != null && (
        <div className="card num" style={{ position: "absolute", top: 8, right: 8, padding: "6px 10px", fontSize: 12 }}>
          {hover === 0 ? "Start" : `After trade ${hover}`}: <b>{fmtMoney(h.equity)}</b>
        </div>
      )}
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: { name: string; n: number; wins: number; pnl: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.pnl)));
  return (
    <div className="card" style={{ padding: 14 }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 13 }}>{title}</h3>
      {!rows.length ? <p className="muted" style={{ margin: 0 }}>No data yet.</p> : (
        <table className="tbl num">
          <thead><tr><th>{title.replace("By ", "")}</th><th className="r">Trades</th><th className="r">Win %</th><th className="r">P&amp;L</th><th style={{ width: "35%" }}></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="r">{r.n}</td>
                <td className="r">{r.n ? Math.round((r.wins / r.n) * 100) + "%" : "–"}</td>
                <td className={`r ${pnlClass(r.pnl)}`}>{fmtMoney(r.pnl, true)}</td>
                <td>
                  <div style={{ height: 8, width: `${(Math.abs(r.pnl) / max) * 100}%`, minWidth: r.n ? 2 : 0, background: r.pnl >= 0 ? "var(--pos)" : "var(--neg)", borderRadius: 2 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function exportCsv(s: Session, tz: string) {
  const head = ["symbol", "side", "type", "lots", "entry", "exit", "sl_initial", "tp", "opened", "closed", "result", "pnl_usd", "swap_usd", "net_usd", "r", "setup", "checklist", "tags", "note"];
  const esc = (v: unknown) => { const x = String(v ?? ""); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const rows = s.trades.filter((t) => t.status === "closed").map((t) => {
    const d = digits(t.symbol);
    return [t.symbol, t.side, t.type, t.initialLots, t.price.toFixed(d), t.closePrice?.toFixed(d), t.initialSl?.toFixed(d), t.tp?.toFixed(d),
      fmtDateTime(t.openedAt!, tz), fmtDateTime(t.closedAt!, tz), t.reason, t.pnl.toFixed(2), swapOf(t).toFixed(2), netOf(t).toFixed(2), rOf(t)?.toFixed(2), t.setup, (t.checks || []).join("; "), t.tags.join("; "), t.note].map(esc).join(",");
  });
  const blob = new Blob([[head.join(","), ...rows].join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${s.name.replace(/[^\w-]+/g, "_")}-trades.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function Analytics({ id }: { id: string }) {
  const s = useSessions((st) => st.sessions[id]);
  const tz = chartTz(usePrefs((p) => p.tz));
  const setups = usePrefs((p) => p.setups);
  const st = useMemo(() => (s ? computeStats(s, tz, setups) : null), [s, tz, setups]);
  const [journalId, setJournalId] = useState<string | null>(null);
  const journalTrade = s?.trades.find((t) => t.id === journalId);

  if (!s || !st) {
    return <main style={{ padding: 40, textAlign: "center" }}><p>This session doesn&apos;t exist.</p><Link className="btn primary" href="/dashboard">Back</Link></main>;
  }

  const cards: [string, React.ReactNode, string?][] = [
    ["Net P&L", <span key="n" className={pnlClass(st.net)}>{fmtMoney(st.net, true)}</span>, fmtPct(st.returnPct)],
    ["Win rate", `${st.winRate.toFixed(1)}%`, `${st.count} closed · ${st.open} open`],
    ["Profit factor", st.profitFactor === Infinity ? "∞" : st.profitFactor.toFixed(2), "gross win ÷ gross loss"],
    ["Expectancy", <span key="e" className={pnlClass(st.expectancy)}>{fmtMoney(st.expectancy, true)}</span>, `avg ${fmtR(st.avgR)} per trade`],
    ["Max drawdown", <span key="d" className="neg">{fmtMoney(-st.maxDd)}</span>, fmtPct(-st.maxDdPct)],
    ["Avg win / loss", <span key="w"><span className="pos">{fmtMoney(st.avgWin)}</span> / <span className="neg">{fmtMoney(st.avgLoss)}</span></span>, `best ${fmtMoney(st.best, true)} · worst ${fmtMoney(st.worst, true)}`],
    ["Streaks", `${st.streakW}W / ${st.streakL}L`, "longest win / loss run"],
    ["Total R", <span key="r" className={pnlClass(st.totalR)}>{fmtR(st.totalR)}</span>, `avg hold ${fmtDuration(st.avgHoldMin)}`],
  ];

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: "20px 16px 60px", display: "grid", gap: 14 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Link className="btn icon-btn" href="/dashboard" title="Dashboard"><Icon name="back" /></Link>
        <div style={{ marginRight: "auto" }}>
          <h1 style={{ margin: 0, fontSize: 19 }}>{s.name}</h1>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>{fmtDay(s.startTime, tz)} → {fmtDay(s.cursor, tz)} · started with {fmtMoney(s.balance0)}</p>
        </div>
        <button className="btn outline" onClick={() => exportCsv(s, tz)} disabled={!st.count}>Export CSV</button>
        <Link className="btn primary" href={`/session/${id}`}>Back to chart</Link>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
        {cards.map(([label, value, sub]) => (
          <div key={label} className="card num" style={{ padding: "12px 14px" }}>
            <div className="muted" style={{ fontSize: 12 }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 600, margin: "4px 0 2px" }}>{value}</div>
            {sub && <div className="muted" style={{ fontSize: 12 }}>{sub}</div>}
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 14 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 13 }}>Equity after each closed trade</h3>
        {st.count ? <EquityCurve curve={st.curve} start={s.balance0} /> : <p className="muted" style={{ margin: 0 }}>Close some trades to see the curve.</p>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14 }}>
        <Breakdown title="By side" rows={st.bySide} />
        <Breakdown title="By symbol" rows={st.bySymbol} />
        <Breakdown title="By weekday" rows={st.byDay} />
        <Breakdown title="By hour opened" rows={st.byHour} />
        <Breakdown title="By setup" rows={st.bySetup} />
        <Breakdown title="By checklist" rows={st.byChecklist} />
        <Breakdown title="By tag" rows={st.byTag} />
      </div>

      <div className="card" style={{ padding: 14, overflowX: "auto" }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 13 }}>Closed trades</h3>
        <table className="tbl num">
          <thead><tr><th>#</th><th>Symbol</th><th>Side</th><th className="r">Lots</th><th className="r">Entry</th><th className="r">Exit</th><th>Opened</th><th>Held</th><th>Result</th><th className="r">Swap</th><th className="r">P&amp;L</th><th className="r">R</th><th>Setup</th><th></th><th>Tags</th><th>Note</th></tr></thead>
          <tbody>
            {st.trades.map((t, i) => {
              const d = digits(t.symbol);
              return (
                <tr key={t.id}>
                  <td className="muted">{i + 1}</td><td>{t.symbol}</td><td><span className={`tag ${t.side}`}>{t.side === "buy" ? "BUY" : "SELL"}</span></td>
                  <td className="r">{t.initialLots.toFixed(2)}</td><td className="r">{t.price.toFixed(d)}</td><td className="r">{t.closePrice?.toFixed(d)}</td>
                  <td className="muted">{fmtDateTime(t.openedAt!, tz)}</td><td className="muted">{fmtDuration(((t.closedAt ?? 0) - (t.openedAt ?? 0)) / 60)}</td>
                  <td>{REASONS[t.reason!]}</td>
                  <td className="r muted">{t.swaps?.length ? fmtMoney(swapOf(t), true) : "—"}</td>
                  <td className={`r ${pnlClass(netOf(t))}`}>{fmtMoney(netOf(t), true)}</td><td className={`r ${pnlClass(netOf(t))}`}>{fmtR(rOf(t))}</td>
                  <td>{t.setup ?? <span className="muted">—</span>}</td>
                  <td><button className="btn outline sm" onClick={() => setJournalId(t.id)}>Journal{t.shots?.entry || t.shots?.exit ? " 📷" : ""}</button></td>
                  <td className="muted">{t.tags.join(", ")}</td><td className="muted" style={{ whiteSpace: "normal", minWidth: 200 }}>{t.note}</td>
                </tr>
              );
            })}
            {!st.count && <tr><td colSpan={16} className="muted" style={{ padding: 16 }}>No closed trades yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {journalTrade && (
        <TradeJournal sid={id} t={journalTrade} tz={tz} onClose={() => setJournalId(null)}
          onChange={(c) => useSessions.getState().update(id, (x) => ({ ...x, trades: x.trades.map((t) => (t.id === journalTrade.id ? { ...t, ...c } : t)) }))} />
      )}
    </main>
  );
}
