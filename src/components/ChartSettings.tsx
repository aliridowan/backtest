"use client";

import { CANDLE_DEFAULT, usePrefs, type CandleColors } from "@/lib/store";

const ROWS: [string, keyof CandleColors, keyof CandleColors | null][] = [
  ["Body", "up", "down"],
  ["Borders", "upBorder", "downBorder"],
  ["Wick", "upWick", "downWick"],
];

// Background and candle / line colours.
export default function ChartSettings() {
  const colors = usePrefs((p) => p.colors), set = usePrefs((p) => p.set);
  const c = { ...CANDLE_DEFAULT, ...colors };
  const pick = (k: keyof CandleColors) => (
    <input type="color" value={c[k]} onChange={(e) => set({ colors: { ...colors, [k]: e.target.value } })} aria-label={k} />
  );
  const row = { display: "grid", gridTemplateColumns: "80px 40px 40px", alignItems: "center", gap: 6 } as const;
  return (
    <div className="pop" style={{ right: 0, width: 200, display: "grid", gap: 8 }}>
      <div style={row}><span>Background</span>{pick("bg")}</div>
      <div style={{ ...row, color: "var(--muted)", fontSize: 11 }}><span /><span>Up</span><span>Down</span></div>
      {ROWS.map(([label, a, b]) => <div key={label} style={row}><span>{label}</span>{pick(a)}{b && pick(b)}</div>)}
      <div style={row}><span>Line</span>{pick("line")}</div>
      <button className="btn outline sm" style={{ justifySelf: "start" }} onClick={() => set({ colors: {} })}>Reset to default</button>
    </div>
  );
}
