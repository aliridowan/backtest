"use client";

// The prop firm challenge pill in the workspace's top bar and its panel:
// profit target, daily loss and max loss left, trading days, editable rules.

import { CHALLENGES, NEXT_PHASE, type ChallengeState } from "@/lib/challenge";
import { fmtDateTime, fmtMoney, fmtPct } from "@/lib/format";
import type { Challenge } from "@/lib/types";

// Label and colour of the pill.
export function challengeBadge(c: Challenge, st: ChallengeState, balance0: number) {
  if (c.failed) return { cls: "fail", text: "✕ Challenge failed" };
  if (st.passed) return { cls: "pass", text: "✓ Passed" };
  const pct = fmtPct((st.profit / balance0) * 100);
  return { cls: st.dailyLeft < st.dailyUsd * 0.3 || st.maxLeft < st.maxUsd * 0.3 ? "warn" : "", text: c.target != null ? `${pct} / ${c.target}%` : pct };
}

// used / limit as a bar; `bad` bars fill towards the limit.
function Meter({ label, value, limit, bad, sub }: { label: string; value: number; limit: number; bad?: boolean; sub: string }) {
  const f = limit > 0 ? Math.max(0, Math.min(1, value / limit)) : 0;
  const color = bad ? (f > 0.7 ? "var(--neg)" : f > 0.4 ? "var(--warn)" : "var(--muted)") : "var(--pos)";
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span>{label}</span><span className="num muted">{sub}</span></div>
      <div className="meter"><div style={{ width: `${f * 100}%`, background: color }} /></div>
    </div>
  );
}

type Props = {
  c: Challenge;
  st: ChallengeState;
  balance0: number;
  tz: string;
  onRules: (change: Partial<Challenge>) => void;
  onNextPhase: () => void;
};

export function ChallengePanel({ c, st, balance0, tz, onRules, onNextPhase }: Props) {
  const next = NEXT_PHASE[c.name];
  const num = (k: "target" | "daily" | "max" | "minDays", label: string) => (
    <label className="field"><span>{label}</span>
      <input className="input sm num" type="number" min="0" step={k === "minDays" ? 1 : 0.5} value={c[k] ?? ""} placeholder="none"
        onChange={(e) => { const v = e.target.value === "" ? null : Number(e.target.value); if (v == null ? k === "target" : v >= 0) onRules({ [k]: v }); }} />
    </label>
  );
  return (
    <div className="pop" style={{ left: 0, width: 300, display: "grid", gap: 12 }}>
      <div>
        <b>{c.name}</b>
        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>Starting balance {fmtMoney(balance0)}. The day resets at 17:00 New York.</div>
      </div>
      {c.failed && (
        <p className="error" style={{ margin: 0, lineHeight: 1.5 }}>
          {c.failed.reason === "daily" ? "Daily loss limit" : "Maximum loss"} hit on {fmtDateTime(c.failed.time, tz)} (equity {fmtMoney(c.failed.equity)}). Every position was closed.
          Step back (←) or use Select bar to go before then and try again.
        </p>
      )}
      {st.passed && <p className="pos" style={{ margin: 0 }}>Target reached in {st.days} trading {st.days === 1 ? "day" : "days"} with nothing open.</p>}
      {st.targetHit && !st.passed && !c.failed && <p className="muted" style={{ margin: 0, fontSize: 12 }}>Target reached{st.days < c.minDays ? `; ${c.minDays - st.days} more trading day(s) needed` : ""}{st.days >= c.minDays ? "; close every position to pass" : ""}.</p>}
      {st.targetUsd != null && <Meter label="Profit target" value={st.profit} limit={st.targetUsd} sub={`${fmtMoney(st.profit, true)} of ${fmtMoney(st.targetUsd)}`} />}
      <Meter label="Daily loss" bad value={st.dailyUsd - st.dailyLeft} limit={st.dailyUsd} sub={`${fmtMoney(Math.max(0, st.dailyLeft))} left of ${fmtMoney(st.dailyUsd)}`} />
      <Meter label={`Max loss${c.trailing ? " (trailing)" : ""}`} bad value={st.maxUsd - st.maxLeft} limit={st.maxUsd} sub={`${fmtMoney(Math.max(0, st.maxLeft))} left · floor ${fmtMoney(st.max)}`} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span>Trading days</span><span className="num">{st.days}{c.minDays ? ` / ${c.minDays}` : ""}</span>
      </div>
      {st.passed && next && <button className="btn primary" onClick={onNextPhase}>Start {next.split("· ")[1] ?? next} (new session)</button>}
      <details>
        <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>Rules</summary>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          {num("target", "Profit target %")}
          {num("daily", "Daily loss %")}
          {num("max", "Max loss %")}
          {num("minDays", "Min. trading days")}
        </div>
        <label className="row-check" style={{ marginTop: 8 }}><input type="checkbox" checked={c.trailing} onChange={(e) => onRules({ trailing: e.target.checked })} /> Trailing max loss (follows the highest balance)</label>
        <p className="muted" style={{ fontSize: 11, margin: "8px 0 0" }}>Presets: {Object.keys(CHALLENGES).filter((k) => k !== "Custom").join(", ")}. Check the firm&apos;s current rules; they change.</p>
      </details>
    </div>
  );
}
