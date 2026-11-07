"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefs, type MarketSession } from "@/lib/store";

// EMA (up to five periods) and market-session boxes, like tradingMind's Indicators menu.
export default function IndicatorMenu({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs();
  const ref = useRef<HTMLDivElement>(null);
  const [periods, setPeriods] = useState(prefs.emaPeriods.join(", "));

  // A click outside the menu and its button closes it.
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.parentElement?.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [onClose]);

  const savePeriods = () => {
    const list = periods.split(/[^0-9]+/).map(Number).filter((n) => n > 0 && n < 1000).slice(0, 5);
    prefs.set({ emaPeriods: list });
    setPeriods(list.join(", "));
  };
  const setSession = (i: number, change: Partial<MarketSession>) =>
    prefs.set({ sessionList: prefs.sessionList.map((s, j) => (j === i ? { ...s, ...change } : s)) });
  const zones = prefs.sessionList.map((s) => s.tz.split("/")[1].replace("_", " ")).join(", ");

  return (
    <div ref={ref} className="pop ind-menu">
      <label className="row"><input type="checkbox" checked={prefs.ema} onChange={(e) => prefs.set({ ema: e.target.checked })} /> <b>EMA</b></label>
      <div className="row sub">Periods
        <input className="input sm" type="text" spellCheck={false} value={periods} onChange={(e) => setPeriods(e.target.value)}
          onBlur={savePeriods} onKeyDown={(e) => { if (e.key === "Enter") savePeriods(); }} />
      </div>
      <label className="row"><input type="checkbox" checked={prefs.sessions} onChange={(e) => prefs.set({ sessions: e.target.checked })} /> <b>Sessions</b> <span className="muted">(M1 – H1)</span></label>
      {prefs.sessionList.map((s, i) => (
        <div key={s.name} className="ses-row">
          <input type="checkbox" checked={s.on} onChange={(e) => setSession(i, { on: e.target.checked })} />
          <span className="swatch" style={{ background: s.color }} />
          <span className="name">{s.name}</span>
          <input className="input sm" type="time" value={s.start} onChange={(e) => e.target.value && setSession(i, { start: e.target.value })} />
          –
          <input className="input sm" type="time" value={s.end} onChange={(e) => e.target.value && setSession(i, { end: e.target.value })} />
        </div>
      ))}
      <div className="row sub">Times are local to each market ({zones}), so summer time is handled.</div>
    </div>
  );
}
