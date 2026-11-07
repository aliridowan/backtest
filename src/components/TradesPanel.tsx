"use client";

import { useState, type ReactNode } from "react";
import { exitPrice, floating, netOf, rOf, swapOf } from "@/lib/broker";
import { digits } from "@/lib/instruments";
import { fmtDateTime, fmtMoney, fmtR, pnlClass } from "@/lib/format";
import { REASONS, type Trade } from "@/lib/types";

// Commission of the whole trade (MT5 takes it at the fill); older trades kept none of their own.
const commCell = (t: Trade) => <td className="r muted">{t.comm ? fmtMoney(-t.comm * t.initialLots, true) : "—"}</td>;

type Props = {
  trades: Trade[];
  bid: Record<string, number>;
  rate: Record<string, number>;
  spreadOf: (sym: string) => number;
  tz: string;
  onClose: (id: string, fraction: number) => void;
  onBreakeven: (id: string) => void;
  onCancel: (id: string) => void;
  onModify: (id: string, change: { sl?: number | null; tp?: number | null; price?: number }) => void;
  onNote: (id: string, change: { note?: string; tags?: string[] }) => void;
  onSelectSymbol: (sym: string) => void;
  onJournal: (id: string) => void; // open the trade's journal page
  summary: ReactNode; // balance, equity, margin… like Exness's bottom bar
  open?: boolean;
  onToggleOpen?: (open: boolean) => void;
};

// An input that commits on Enter / blur and shows the saved value otherwise.
function PriceCell({ value, d, onSave }: { value: number | null; d: number; onSave: (v: number | null) => void }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text == null) return;
    const v = text.trim() === "" ? null : Number(text);
    setText(null);
    if (v === null || v > 0) onSave(v);
  };
  return (
    <input
      className="input sm num"
      style={{ width: 92 }}
      value={text ?? (value == null ? "" : value.toFixed(d))}
      placeholder="—"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setText(null); }}
    />
  );
}

export default function TradesPanel(p: Props) {
  const [tab, setTab] = useState<"open" | "pending" | "history">("open");
  const [localOpen, setLocalOpen] = useState(true);
  const open = p.open !== undefined ? p.open : localOpen;
  const toggle = (v: boolean) => {
    setLocalOpen(v);
    p.onToggleOpen?.(v);
  };
  const open_ = p.trades.filter((t) => t.status === "open");
  const pending = p.trades.filter((t) => t.status === "pending");
  const history = p.trades.filter((t) => t.status === "closed" || t.status === "cancelled").sort((a, b) => (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt));

  const side = (t: Trade) => <span className={`tag ${t.side}`}>{t.side === "buy" ? "BUY" : "SELL"}</span>;
  const journal = (t: Trade) => <button className="btn outline sm" title="Screenshots, setup, checklist and notes" onClick={() => p.onJournal(t.id)}>Journal{t.shots?.entry || t.shots?.exit ? " 📷" : ""}</button>;
  const sym = (t: Trade) => <button className="btn sm" style={{ padding: 0, height: "auto" }} onClick={() => p.onSelectSymbol(t.symbol)}>{t.symbol}</button>;

  return (
    <div className={`ws-bottom ${open ? "open" : "closed"}`}>
      <div className="tabs">
        <div className="tabs-list" style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          {([["open", `Positions (${open_.length})`], ["pending", `Orders (${pending.length})`], ["history", `History (${history.length})`]] as const).map(([k, label]) => (
            <button key={k} className={`btn sm ${tab === k && open ? "on" : ""}`} onClick={() => { setTab(k); if (!open) toggle(true); }}>{label}</button>
          ))}
        </div>
        <button className="btn sm tabs-toggle-btn" onClick={() => toggle(!open)}>{open ? "▾ Hide" : "▴ Show"}</button>
        <div className="acct num">{p.summary}</div>
      </div>
      {open && (
        <div className="body">
          {tab === "open" && (
            <table className="tbl num">
              <thead><tr><th>Symbol</th><th>Side</th><th className="r">Lots</th><th className="r">Entry</th><th>SL</th><th>TP</th><th className="r">Price</th><th className="r">Commission</th><th className="r">Swap</th><th className="r">P&amp;L</th><th>Opened</th><th></th></tr></thead>
              <tbody>
                {open_.map((t) => {
                  const d = digits(t.symbol), bid = p.bid[t.symbol], spr = p.spreadOf(t.symbol);
                  const fl = bid != null ? floating(t, bid, spr, p.rate[t.symbol] ?? 1) : 0;
                  return (
                    <tr key={t.id}>
                      <td>{sym(t)}</td><td>{side(t)}</td><td className="r">{t.lots.toFixed(2)}</td><td className="r">{t.price.toFixed(d)}</td>
                      <td><PriceCell value={t.sl} d={d} onSave={(v) => p.onModify(t.id, { sl: v })} /></td>
                      <td><PriceCell value={t.tp} d={d} onSave={(v) => p.onModify(t.id, { tp: v })} /></td>
                      <td className="r">{bid != null ? exitPrice(t, bid, spr).toFixed(d) : "—"}</td>
                      {commCell(t)}
                      <td className="r muted">{t.swaps?.length ? fmtMoney(swapOf(t), true) : "—"}</td>
                      <td className={`r ${pnlClass(fl)}`}>{fmtMoney(fl, true)}</td>
                      <td className="muted">{fmtDateTime(t.openedAt!, p.tz)}</td>
                      <td style={{ display: "flex", gap: 4 }}>
                        {journal(t)}
                        <button className="btn outline sm" onClick={() => p.onBreakeven(t.id)} title="Move the stop to the entry price">BE</button>
                        <button className="btn outline sm" onClick={() => p.onClose(t.id, 0.5)} disabled={t.lots < 0.02} title="Close half">50%</button>
                        <button className="btn outline sm danger" onClick={() => p.onClose(t.id, 1)}>Close</button>
                      </td>
                    </tr>
                  );
                })}
                {!open_.length && <tr><td colSpan={12} className="muted" style={{ padding: 16 }}>No open positions. Use the Buy / Sell panel on the right.</td></tr>}
              </tbody>
            </table>
          )}
          {tab === "pending" && (
            <table className="tbl num">
              <thead><tr><th>Symbol</th><th>Side</th><th>Type</th><th className="r">Lots</th><th>Price</th><th>SL</th><th>TP</th><th>Placed</th><th></th></tr></thead>
              <tbody>
                {pending.map((t) => {
                  const d = digits(t.symbol);
                  return (
                    <tr key={t.id}>
                      <td>{sym(t)}</td><td>{side(t)}</td><td>{t.type}</td><td className="r">{t.lots.toFixed(2)}</td>
                      <td><PriceCell value={t.price} d={d} onSave={(v) => v != null && p.onModify(t.id, { price: v })} /></td>
                      <td><PriceCell value={t.sl} d={d} onSave={(v) => p.onModify(t.id, { sl: v })} /></td>
                      <td><PriceCell value={t.tp} d={d} onSave={(v) => p.onModify(t.id, { tp: v })} /></td>
                      <td className="muted">{fmtDateTime(t.createdAt, p.tz)}</td>
                      <td><button className="btn outline sm danger" onClick={() => p.onCancel(t.id)}>Cancel</button></td>
                    </tr>
                  );
                })}
                {!pending.length && <tr><td colSpan={9} className="muted" style={{ padding: 16 }}>No pending orders.</td></tr>}
              </tbody>
            </table>
          )}
          {tab === "history" && (
            <table className="tbl num">
              <thead><tr><th>Symbol</th><th>Side</th><th className="r">Lots</th><th className="r">Entry</th><th className="r">Exit</th><th>Result</th><th className="r">Commission</th><th className="r">Swap</th><th className="r" title="Net: commission and swap included">P&amp;L</th><th className="r">R</th><th>Opened</th><th>Closed</th><th>Setup</th><th></th><th>Tags</th><th>Note</th></tr></thead>
              <tbody>
                {history.map((t) => {
                  const d = digits(t.symbol);
                  if (t.status === "cancelled") {
                    return <tr key={t.id} className="muted"><td>{t.symbol}</td><td>{side(t)}</td><td className="r">{t.initialLots.toFixed(2)}</td><td className="r">{t.price.toFixed(d)}</td><td></td><td>cancelled {t.type}{t.reason === "margin" ? " (no margin)" : ""}</td><td></td><td></td><td></td><td></td><td>{fmtDateTime(t.createdAt, p.tz)}</td><td></td><td></td><td></td><td></td><td></td></tr>;
                  }
                  return (
                    <tr key={t.id}>
                      <td>{sym(t)}</td><td>{side(t)}</td><td className="r">{t.initialLots.toFixed(2)}</td><td className="r">{t.price.toFixed(d)}</td><td className="r">{t.closePrice?.toFixed(d)}</td>
                      <td>{REASONS[t.reason!]}{t.closes.length > 1 ? ` (${t.closes.length} parts)` : ""}</td>
                      {commCell(t)}
                      <td className="r muted">{t.swaps?.length ? fmtMoney(swapOf(t), true) : "—"}</td>
                      <td className={`r ${pnlClass(netOf(t))}`}>{fmtMoney(netOf(t), true)}</td>
                      <td className={`r ${pnlClass(netOf(t))}`}>{fmtR(rOf(t))}</td>
                      <td className="muted">{fmtDateTime(t.openedAt!, p.tz)}</td><td className="muted">{fmtDateTime(t.closedAt!, p.tz)}</td>
                      <td>{t.setup ? <>{t.setup}{t.checks && <span className="muted"> · {t.checks.length} ✓</span>}</> : <span className="muted">—</span>}</td>
                      <td>{journal(t)}</td>
                      <td><input key={t.tags.join()} className="input sm" style={{ width: 120 }} defaultValue={t.tags.join(", ")} placeholder="London, A+" onBlur={(e) => p.onNote(t.id, { tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></td>
                      <td><input key={t.note} className="input sm" style={{ width: 220 }} defaultValue={t.note} placeholder="Why did you take it?" onBlur={(e) => p.onNote(t.id, { note: e.target.value })} /></td>
                    </tr>
                  );
                })}
                {!history.length && <tr><td colSpan={16} className="muted" style={{ padding: 16 }}>Closed trades show up here.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
