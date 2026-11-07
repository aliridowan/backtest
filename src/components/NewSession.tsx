"use client";

import { useEffect, useMemo, useState } from "react";
import { dataRange, getIndex, type MarketIndex } from "@/lib/market";
import { uid, usePrefs } from "@/lib/store";
import { dateInput, fromDateInput } from "@/lib/format";
import { accountFor, ACCOUNT_TYPES, LEVERAGES } from "@/lib/broker";
import { CHALLENGE_FOR, CHALLENGES, challengeFrom } from "@/lib/challenge";
import type { Session } from "@/lib/types";

const DAY = 86400;

export default function NewSession({ onCreate, onClose }: { onCreate: (s: Session) => void; onClose: () => void }) {
  const lastTf = usePrefs((p) => p.lastTf);
  const [index, setIndex] = useState<MarketIndex | null>(null);
  const [error, setError] = useState("");
  const [f, setF] = useState({ name: "", symbol: "EURUSD", start: "", end: "", balance: "10000", risk: "1", commission: "0", type: "Standard", leverage: "500", challenge: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => { getIndex().then(setIndex, (e) => setError(String(e))); }, []);

  // Leave a month of history before the start and some data after it.
  const range = useMemo(() => {
    if (!index) return null;
    const r = dataRange(f.symbol);
    return { min: r.from + 30 * DAY, max: r.to - 7 * DAY };
  }, [index, f.symbol]);

  useEffect(() => {
    if (range && !f.start) setF((x) => ({ ...x, start: dateInput(range.max - 180 * DAY) }));
  }, [range, f.start]);

  const randomStart = () => {
    if (!range) return;
    const t = range.min + Math.random() * (range.max - range.min);
    setF({ ...f, start: dateInput(t) });
  };

  const groups = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const s of index?.symbols || []) g.set(s.group, [...(g.get(s.group) || []), s.name]);
    return [...g.entries()];
  }, [index]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!range) return;
    const start = fromDateInput(f.start), end = f.end ? fromDateInput(f.end) + DAY : null;
    const balance = Number(f.balance), risk = Number(f.risk), commission = Number(f.commission);
    if (!(start >= range.min && start <= range.max)) return setError(`Start must be between ${dateInput(range.min)} and ${dateInput(range.max)}.`);
    if (end != null && end <= start + DAY) return setError("End must be after the start.");
    if (!(balance > 0)) return setError("Balance must be more than 0.");
    if (!(risk > 0 && risk <= 100)) return setError("Risk must be between 0 and 100%.");
    if (!(commission >= 0)) return setError("Commission can't be negative.");
    onCreate({
      id: uid(),
      name: f.name.trim() || `${f.symbol} from ${f.start}`,
      createdAt: Date.now(),
      symbol: f.symbol,
      tf: lastTf,
      startTime: start,
      endTime: end,
      cursor: start,
      balance0: balance,
      riskPct: risk,
      commission,
      spreads: {},
      account: { ...accountFor(f.type), leverage: Number(f.leverage), swaps: true, floatingSpread: true, swapPts: {} },
      ...(f.challenge ? { challenge: challengeFrom(f.challenge) } : {}),
      trades: [],
      drawings: {},
    });
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <h2>New backtest session</h2>
        <div style={{ display: "grid", gap: 12 }}>
          <label className="field"><span>Name</span><input className="input" value={f.name} onChange={set("name")} placeholder="e.g. London breakout, 2024" autoFocus /></label>
          <label className="field">
            <span>Symbol (you can switch symbols inside the session too)</span>
            <select className="input" value={f.symbol} onChange={set("symbol")}>
              {groups.map(([g, list]) => <optgroup key={g} label={g}>{list.map((s) => <option key={s}>{s}</option>)}</optgroup>)}
            </select>
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label className="field">
              <span>Start date</span>
              <input className="input" type="date" value={f.start} onChange={set("start")} min={range ? dateInput(range.min) : undefined} max={range ? dateInput(range.max) : undefined} required />
            </label>
            <label className="field"><span>End date (optional)</span><input className="input" type="date" value={f.end} onChange={set("end")} /></label>
          </div>
          <button type="button" className="btn outline sm" style={{ justifySelf: "start" }} onClick={randomStart} disabled={!range}>
            Random start date (no hindsight)
          </button>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label className="field">
              <span>Account type (Exness or FundingPips)</span>
              <select className="input" value={f.type} onChange={(e) => {
                const k = ACCOUNT_TYPES[e.target.value];
                setF({ ...f, type: e.target.value, commission: String(k.commission), leverage: k.prop ? String(k.prop.leverage) : f.leverage, challenge: CHALLENGE_FOR[e.target.value] ?? f.challenge });
              }}>
                {Object.entries(ACCOUNT_TYPES).map(([k, v]) => <option key={k} value={k}>{k} · margin call {v.marginCall}%, stop out {v.stopOut}%</option>)}
              </select>
            </label>
            <label className="field">
              <span>Leverage</span>
              <select className="input" value={f.leverage} onChange={set("leverage")}>
                {LEVERAGES.map((l) => <option key={l} value={l}>1:{l}</option>)}
              </select>
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <label className="field"><span>Balance ($)</span><input className="input num" inputMode="decimal" value={f.balance} onChange={set("balance")} /></label>
            <label className="field"><span>Risk per trade (%)</span><input className="input num" inputMode="decimal" value={f.risk} onChange={set("risk")} /></label>
            <label className="field"><span>Commission $/lot</span><input className="input num" inputMode="decimal" value={f.commission} onChange={set("commission")} /></label>
          </div>
          {ACCOUNT_TYPES[f.type].prop && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              FundingPips MT5: ${ACCOUNT_TYPES[f.type].commission} per lot round turn on forex and gold, 0.04% on crypto, none on oil and indices, raw spreads,
              gold 1:{ACCOUNT_TYPES[f.type].prop!.levCaps.XAUUSD}, oil 1:{ACCOUNT_TYPES[f.type].prop!.levCaps.USOIL}, indices 1:{ACCOUNT_TYPES[f.type].prop!.levCaps.US30}, at most 20 lots per order.
            </p>
          )}
          <label className="field">
            <span>Prop firm challenge (daily loss, max loss, profit target)</span>
            <select className="input" value={f.challenge} onChange={set("challenge")}>
              <option value="">None</option>
              {Object.entries(CHALLENGES).map(([k, c]) => <option key={k} value={k}>{k}{k !== "Custom" ? ` · ${c.target != null ? `target ${c.target}%, ` : ""}daily ${c.daily}%, max ${c.max}%${c.trailing ? " trailing" : ""}` : ""}</option>)}
            </select>
          </label>
          {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button type="button" className="btn outline" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!range}>Start backtesting</button>
          </div>
        </div>
      </form>
    </div>
  );
}
