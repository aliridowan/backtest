"use client";

// Trade journal: the setups (strategies with a checklist) and one trade's page
// with its entry / exit screenshots, setup, ticked rules, tags and note.

import { useEffect, useState } from "react";
import { netOf, rOf } from "@/lib/broker";
import { digits } from "@/lib/instruments";
import { getShot, shotKey, type ShotKind } from "@/lib/shots";
import { usePrefs, type Setup } from "@/lib/store";
import { fmtDateTime, fmtMoney, fmtR, pnlClass } from "@/lib/format";
import { REASONS, type Trade } from "@/lib/types";

export type JournalChange = { note?: string; tags?: string[]; setup?: string; checks?: string[] };

// Add, rename and delete setups; the checklist is one rule per line.
export function SetupsDialog({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs();
  const [list, setList] = useState(() => prefs.setups.map((x) => ({ name: x.name, text: x.checklist.join("\n") })));
  const [error, setError] = useState("");
  const edit = (i: number, change: Partial<(typeof list)[number]>) => setList(list.map((x, j) => (j === i ? { ...x, ...change } : x)));

  const save = () => {
    const out: Setup[] = list.map((x) => ({ name: x.name.trim(), checklist: x.text.split("\n").map((l) => l.trim()).filter(Boolean) }));
    if (out.some((x) => !x.name)) return setError("Every setup needs a name.");
    if (new Set(out.map((x) => x.name)).size !== out.length) return setError("Two setups have the same name.");
    prefs.set({ setups: out });
    onClose();
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: "min(560px, 100%)" }}>
        <h2>Setups &amp; checklists</h2>
        <p className="muted" style={{ margin: "-8px 0 14px", fontSize: 12 }}>Pick a setup when you place an order and tick its rules. Analytics then shows the win rate per setup, and with or without every rule ticked.</p>
        <div style={{ display: "grid", gap: 12 }}>
          {list.map((x, i) => (
            <div key={i} className="card" style={{ padding: 12, display: "grid", gap: 8, background: "var(--bg)" }}>
              <div style={{ display: "flex", gap: 6 }}>
                <input className="input" value={x.name} placeholder="Setup name" aria-label="Setup name" onChange={(e) => edit(i, { name: e.target.value })} />
                <button className="btn danger" onClick={() => setList(list.filter((_, j) => j !== i))}>Delete</button>
              </div>
              <textarea className="input" style={{ height: 96, padding: 8, resize: "vertical" }} value={x.text} placeholder={"One rule per line, e.g.\nHigher timeframe trend agrees"} aria-label="Checklist" onChange={(e) => edit(i, { text: e.target.value })} />
            </div>
          ))}
          <button className="btn outline" style={{ justifySelf: "start" }} onClick={() => setList([...list, { name: "", text: "" }])}>+ Add setup</button>
          {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="btn outline" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// One screenshot, loaded from IndexedDB; a click shows it full size.
export function Shot({ sid, t, kind, onOpen }: { sid: string; t: Trade; kind: ShotKind; onOpen?: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const has = !!t.shots?.[kind];
  useEffect(() => {
    let live = true;
    if (has) getShot(shotKey(sid, t.id, kind)).then((u) => live && setUrl(u ?? null), () => {});
    else setUrl(null);
    return () => { live = false; };
  }, [sid, t.id, kind, has]);
  if (!url) return <div className="shot empty">{has ? "Loading…" : kind === "entry" ? "No entry screenshot" : t.status === "closed" ? "No exit screenshot" : "Taken when the trade closes"}</div>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="shot" src={url} alt={`${t.symbol} ${kind}`} onClick={() => onOpen?.(url)} />;
}

export function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return (
    <div className="modal-bg" style={{ zIndex: 120, cursor: "zoom-out" }} onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="Screenshot" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8, border: "1px solid var(--line)" }} />
    </div>
  );
}

export function TradeJournal({ sid, t, tz, onChange, onClose }: { sid: string; t: Trade; tz: string; onChange: (c: JournalChange) => void; onClose: () => void }) {
  const setups = usePrefs((p) => p.setups);
  const [big, setBig] = useState<string | null>(null);
  const setup = setups.find((x) => x.name === t.setup);
  // Rules of a setup that was renamed or edited since stay visible as they were ticked.
  const rules = setup ? [...setup.checklist, ...(t.checks || []).filter((c) => !setup.checklist.includes(c))] : t.checks || [];
  const d = digits(t.symbol), closed = t.status === "closed";

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal journal">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <span className={`tag ${t.side}`}>{t.side === "buy" ? "BUY" : "SELL"}</span>
          <b style={{ fontSize: 16 }}>{t.symbol}</b>
          <span className="muted num">{t.initialLots.toFixed(2)} lots @ {t.price.toFixed(d)}{closed && ` → ${t.closePrice?.toFixed(d)}`}</span>
          {closed && <b className={`num ${pnlClass(netOf(t))}`} style={{ marginLeft: "auto" }}>{fmtMoney(netOf(t), true)} · {fmtR(rOf(t))}</b>}
          <button className="btn icon-btn" style={{ marginLeft: closed ? 0 : "auto" }} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="shots">
          <figure><figcaption>Entry · {t.openedAt != null ? fmtDateTime(t.openedAt, tz) : "not filled yet"}</figcaption><Shot sid={sid} t={t} kind="entry" onOpen={setBig} /></figure>
          <figure><figcaption>Exit · {closed ? `${REASONS[t.reason!]}, ${fmtDateTime(t.closedAt!, tz)}` : "still open"}</figcaption><Shot sid={sid} t={t} kind="exit" onOpen={setBig} /></figure>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 14, marginTop: 14 }} className="journal-form">
          <div className="field">
            <span>Setup</span>
            <select className="input" value={t.setup ?? ""} onChange={(e) => onChange({ setup: e.target.value || undefined, checks: [] })}>
              <option value="">No setup</option>
              {setups.map((x) => <option key={x.name}>{x.name}</option>)}
              {t.setup && !setup && <option>{t.setup}</option>}
            </select>
            {rules.length > 0 && (
              <div className="checklist">
                {rules.map((c) => (
                  <label key={c} className="row-check"><input type="checkbox" checked={!!t.checks?.includes(c)} onChange={(e) => onChange({ checks: e.target.checked ? [...(t.checks || []), c] : (t.checks || []).filter((x) => x !== c) })} /> {c}</label>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
            <label className="field"><span>Tags (comma separated)</span>
              <input className="input" defaultValue={t.tags.join(", ")} placeholder="London, news, A+" onBlur={(e) => onChange({ tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
            </label>
            <label className="field"><span>Notes</span>
              <textarea className="input" style={{ height: 110, padding: 8, resize: "vertical" }} defaultValue={t.note} placeholder="Why did you take it? What did you see? What would you do differently?" onBlur={(e) => onChange({ note: e.target.value })} />
            </label>
          </div>
        </div>
      </div>
      {big && <Lightbox url={big} onClose={() => setBig(null)} />}
    </div>
  );
}
