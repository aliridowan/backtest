"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessions, usePrefs, chartTz } from "@/lib/store";
import { balanceOf, netOf } from "@/lib/broker";
import { closedTrades } from "@/lib/stats";
import { challengeState } from "@/lib/challenge";
import { deleteShots } from "@/lib/shots";
import { fmtDateTime, fmtDay, fmtMoney, fmtPct, fmtR, pnlClass } from "@/lib/format";
import type { Session, Trade } from "@/lib/types";
import NewSession from "./NewSession";
import { Logo } from "./brand";

// Equity after each closed trade, as a small line.
function Spark({ s }: { s: Session }) {
  const pts = closedTrades(s).reduce<number[]>((a, t) => [...a, a[a.length - 1] + netOf(t)], [s.balance0]);
  if (pts.length < 2) return <div className="spark empty" />;
  const lo = Math.min(...pts), hi = Math.max(...pts), r = hi - lo || 1;
  const d = pts.map((v, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * 100).toFixed(1)},${(28 - ((v - lo) / r) * 26).toFixed(1)}`).join("");
  const up = pts[pts.length - 1] >= s.balance0;
  return <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none"><path d={d} fill="none" stroke={up ? "var(--pos)" : "var(--neg)"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}

function ChallengeTag({ s }: { s: Session }) {
  const c = s.challenge;
  if (!c) return null;
  const bal = balanceOf(s);
  const st = challengeState(s, c, bal, bal);
  const [cls, text] = c.failed ? ["fail", "Failed"] : st.passed ? ["pass", "Passed"] : ["", c.target != null ? `${fmtPct((st.profit / s.balance0) * 100)} / ${c.target}%` : "In progress"];
  return <span className={`chal sm ${cls}`} title={c.name}>{c.name.replace(" · ", " ")} · {text}</span>;
}

const rOf = (t: Trade) => (t.riskUsd ? netOf(t) / t.riskUsd : null);

type Filter = "all" | "plain" | "challenge";
type Sort = "recent" | "name" | "pnl" | "trades";

export default function Dashboard() {
  const router = useRouter();
  const sessions = useSessions((s) => s.sessions);
  const { add, remove, replaceAll } = useSessions.getState();
  const tz = chartTz(usePrefs((p) => p.tz));
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const fileRef = useRef<HTMLInputElement>(null);

  // "Start a backtest" on the landing page opens the new session form here.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("new")) {
      setCreating(true);
      window.history.replaceState(null, "", "/dashboard");
    }
  }, []);

  const list = useMemo(() => Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt), [sessions]);
  const last = list.reduce<Session | undefined>((a, s) => (!a || (s.usedAt ?? s.createdAt) > (a.usedAt ?? a.createdAt) ? s : a), undefined);

  // Totals over every session's closed trades.
  const totals = useMemo(() => {
    const all = list.flatMap((s) => closedTrades(s).map((t) => ({ t, s })));
    const nets = all.map(({ t }) => netOf(t));
    const won = nets.filter((v) => v > 0), lost = nets.filter((v) => v <= 0);
    const gw = won.reduce((a, v) => a + v, 0), gl = -lost.reduce((a, v) => a + v, 0);
    const rs = all.map(({ t }) => rOf(t)).filter((v): v is number => v != null);
    const recent = [...all].sort((a, b) => (b.t.closedAt ?? 0) - (a.t.closedAt ?? 0)).slice(0, 8);
    return {
      n: all.length, wins: won.length, net: gw - gl, pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : null,
      avgR: rs.length ? rs.reduce((a, v) => a + v, 0) / rs.length : null, recent,
      open: list.reduce((a, s) => a + s.trades.filter((t) => t.status === "open" || t.status === "pending").length, 0),
    };
  }, [list]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = list.filter((s) =>
      (filter === "all" || (filter === "challenge") === !!s.challenge) &&
      (!q || s.name.toLowerCase().includes(q) || s.symbol.toLowerCase().includes(q)));
    const pnl = (s: Session) => balanceOf(s) - s.balance0;
    if (sort === "name") out.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "pnl") out.sort((a, b) => pnl(b) / b.balance0 - pnl(a) / a.balance0);
    else if (sort === "trades") out.sort((a, b) => closedTrades(b).length - closedTrades(a).length);
    return out;
  }, [list, query, filter, sort]);

  const saveName = () => {
    const n = renaming?.name.trim();
    if (renaming && n) useSessions.getState().update(renaming.id, (x) => ({ ...x, name: n }));
    setRenaming(null);
  };

  const exportAll = () => {
    const blob = new Blob([JSON.stringify({ app: "backtestmind", version: 1, sessions }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `backtestmind-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importFile = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (data?.app !== "backtestmind" || typeof data.sessions !== "object") throw new Error("not a BacktestMind export");
      const incoming = data.sessions as Record<string, Session>;
      replaceAll({ ...sessions, ...incoming });
      setMsg(`Imported ${Object.keys(incoming).length} session(s).`);
    } catch (e) {
      setMsg(`Import failed: ${(e as Error).message}`);
    }
  };

  const kpis: [string, React.ReactNode, string?][] = [
    ["Sessions", list.length, totals.open ? `${totals.open} open / pending order${totals.open === 1 ? "" : "s"}` : undefined],
    ["Closed trades", totals.n],
    ["Win rate", totals.n ? `${Math.round((totals.wins / totals.n) * 100)}%` : "—", totals.n ? `${totals.wins} won · ${totals.n - totals.wins} lost` : undefined],
    ["Net P&L", <span key="net" className={pnlClass(totals.net)}>{fmtMoney(totals.net, true)}</span>, "all sessions, after costs"],
    ["Profit factor", totals.pf == null ? "—" : totals.pf === Infinity ? "∞" : totals.pf.toFixed(2)],
    ["Average R", <span key="r" className={pnlClass(totals.avgR ?? 0)}>{fmtR(totals.avgR)}</span>, "trades with a stop"],
  ];

  return (
    <div className="dash">
      <nav className="dash-nav">
        <Link href="/" className="brand"><Logo /> BacktestMind</Link>
        <span className="dash-crumb">Dashboard</span>
        <div className="dash-actions">
          <button className="btn outline" onClick={exportAll} disabled={!list.length} title="Download every session as a JSON file">Export</button>
          <button className="btn outline" onClick={() => fileRef.current?.click()} title="Add sessions from an export file">Import</button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }} />
          <button className="btn primary" onClick={() => setCreating(true)}>+ New session</button>
        </div>
      </nav>

      <main className="dash-main">
        <header className="dash-head">
          <div>
            <h1>Dashboard</h1>
            <p className="muted">Your backtests, results and latest trades in one place.</p>
          </div>
          {last && (
            <Link className="card resume" href={`/session/${last.id}`}>
              <span className="muted">Continue where you left off</span>
              <b>{last.name}</b>
              <span className="muted">{last.symbol} · {fmtDay(last.cursor, tz)}</span>
              <span className="resume-go">Resume →</span>
            </Link>
          )}
        </header>

        <section className="kpis">
          {kpis.map(([label, value, sub]) => (
            <div key={label} className="card kpi">
              <span className="kpi-label">{label}</span>
              <b className="kpi-value num">{value}</b>
              {sub && <span className="kpi-sub muted">{sub}</span>}
            </div>
          ))}
        </section>

        <section className="dash-section">
          <div className="dash-section-head">
            <h2>Sessions</h2>
            {msg && <span className="muted">{msg}</span>}
            <div className="dash-tools">
              <input className="input" type="search" placeholder="Search name or symbol" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search sessions" />
              <div className="seg">
                {([["all", "All"], ["plain", "Practice"], ["challenge", "Challenges"]] as [Filter, string][]).map(([k, t]) => (
                  <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{t}</button>
                ))}
              </div>
              <select className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort sessions">
                <option value="recent">Newest first</option>
                <option value="name">Name</option>
                <option value="pnl">Best P&amp;L</option>
                <option value="trades">Most trades</option>
              </select>
            </div>
          </div>

          {!list.length ? (
            <div className="card empty-card">
              <h3>No sessions yet</h3>
              <p className="muted">A session is one practice account: pick a market, a start date and a balance (or a prop firm challenge), then trade forward from there.</p>
              <button className="btn primary" onClick={() => setCreating(true)}>Create your first session</button>
            </div>
          ) : !shown.length ? (
            <div className="card empty-card"><p className="muted" style={{ margin: 0 }}>No session matches.</p></div>
          ) : (
            <div className="session-grid">
              {shown.map((s) => {
                const closed = closedTrades(s);
                const w = closed.filter((t) => netOf(t) > 0).length;
                const bal = balanceOf(s), pnl = bal - s.balance0;
                return (
                  <div key={s.id} className="card session-card">
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                        {renaming?.id === s.id ? (
                          <input className="input sm rename" autoFocus maxLength={80} value={renaming.name} aria-label="Session name"
                            onChange={(e) => setRenaming({ id: s.id, name: e.target.value })} onBlur={saveName}
                            onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setRenaming(null); }} />
                        ) : (
                          <b className="session-name" title="Double-click to rename" onDoubleClick={() => setRenaming({ id: s.id, name: s.name })}>{s.name}</b>
                        )}
                        <span className="sym">{s.symbol}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        {fmtDay(s.startTime, tz)} → {fmtDay(s.cursor, tz)}{s.endTime ? ` (ends ${fmtDay(s.endTime - 86400, tz)})` : ""}
                      </div>
                      <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <span className="chip">{s.account?.type ?? "Standard"}</span>
                        <ChallengeTag s={s} />
                      </div>
                    </div>
                    <Spark s={s} />
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                      <div className="stat" style={{ padding: 0 }}><span>Balance</span><b className="num">{fmtMoney(bal)}</b></div>
                      <div className="stat" style={{ padding: 0 }}><span>P&amp;L</span><b className={`num ${pnlClass(pnl)}`}>{fmtPct((pnl / s.balance0) * 100)}</b></div>
                      <div className="stat" style={{ padding: 0 }}><span>Trades · win</span><b className="num">{closed.length} · {closed.length ? Math.round((w / closed.length) * 100) : 0}%</b></div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <Link className="btn primary sm" href={`/session/${s.id}`}>Continue</Link>
                      <Link className="btn outline sm" href={`/session/${s.id}/stats`}>Analytics</Link>
                      {confirmId === s.id ? (
                        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                          <button className="btn outline sm" onClick={() => setConfirmId(null)}>Keep</button>
                          <button className="btn danger sm" onClick={() => { remove(s.id); deleteShots(s.id).catch(() => {}); setConfirmId(null); }}>Delete for good</button>
                        </span>
                      ) : (
                        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                          <button className="btn sm" onClick={() => setRenaming({ id: s.id, name: s.name })}>Rename</button>
                          <button className="btn danger sm" onClick={() => setConfirmId(s.id)}>Delete</button>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {totals.recent.length > 0 && (
          <section className="dash-section">
            <div className="dash-section-head"><h2>Recent trades</h2></div>
            <div className="card table-card">
              <table className="dash-table">
                <thead>
                  <tr><th>Closed</th><th>Session</th><th>Symbol</th><th>Side</th><th>Setup</th><th className="r">Net</th><th className="r">R</th></tr>
                </thead>
                <tbody>
                  {totals.recent.map(({ t, s }) => (
                    <tr key={s.id + t.id} onClick={() => router.push(`/session/${s.id}/stats`)} title="Open this session's analytics">
                      <td className="num">{fmtDateTime(t.closedAt ?? 0, tz)}</td>
                      <td>{s.name}</td>
                      <td>{t.symbol}</td>
                      <td><span className={`side ${t.side}`}>{t.side.toUpperCase()}</span></td>
                      <td className="muted">{t.setup || "—"}</td>
                      <td className={`r num ${pnlClass(netOf(t))}`}>{fmtMoney(netOf(t), true)}</td>
                      <td className={`r num ${pnlClass(rOf(t) ?? 0)}`}>{fmtR(rOf(t))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <footer className="dash-foot muted">Sessions, journals and screenshots stay in this browser. Use Export to back them up (screenshots aren&apos;t included).</footer>
      </main>

      {creating && (
        <NewSession
          onClose={() => setCreating(false)}
          onCreate={(s) => { add(s); router.push(`/session/${s.id}`); }}
        />
      )}
    </div>
  );
}
