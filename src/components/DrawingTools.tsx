"use client";

// Drawing UI like TradingView's (ported from tradingMind): the tool column,
// the floating bar for the selected drawing, the settings dialog with
// templates, the right-click menu and the text box for notes.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ReplayChart } from "@/lib/chart";
import { COLORS, defaultStyle, fromLocal, isPos, LINE_TOOLS, NO_STYLE, optsOf, pick, TEXT_TOOLS, toLocal, toolLabel, TOOLS, type Opts } from "@/lib/drawings";
import { usePrefs } from "@/lib/store";
import type { Drawing } from "@/lib/types";
import { Icon } from "./icons";

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

// Change a drawing's style and remember it for that tool.
function setStyle(rc: ReplayChart, d: Drawing, change: Opts) {
  const next = { ...d, style: { ...d.style, ...change } };
  const prefs = usePrefs.getState();
  prefs.set({ toolStyle: { ...prefs.toolStyle, [d.name]: pick(d.name, optsOf(next)) } });
  rc.update(next);
}

// ------------------------------------------------------------ tool column

export function ToolColumn({ rc, tool, onTool, hidden, onHidden }: {
  rc: ReplayChart | null; tool: string | null; onTool: (name: string | null) => void; hidden: boolean; onHidden: (on: boolean) => void;
}) {
  const prefs = usePrefs();
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(false), 2500); return () => clearTimeout(t); }, [confirm]);
  const sep = <span style={{ height: 1, width: 24, background: "var(--line)", margin: "4px 0", flex: "none" }} />;
  return (
    <>
      <button className={`btn icon-btn ${tool == null ? "on" : ""}`} title="Cursor (Esc)" onClick={() => onTool(null)}><Icon name="cursor" /></button>
      {sep}
      {TOOLS.map((t, i) => t === "-" ? <span key={i} style={{ height: 1, width: 24, background: "var(--line)", margin: "4px 0", flex: "none" }} /> : (
        <button key={t.name} className={`btn icon-btn ${tool === t.name ? "on" : ""}`} title={t.label} aria-label={t.label} onClick={() => onTool(tool === t.name ? null : t.name)}><Icon name={t.name} /></button>
      ))}
      {sep}
      <button className={`btn icon-btn ${prefs.magnet ? "on" : ""}`} title="Magnet: snap to candle OHLC" onClick={() => prefs.set({ magnet: !prefs.magnet })}><Icon name="magnet" /></button>
      <button className={`btn icon-btn ${hidden ? "on" : ""}`} title="Hide / show drawings" onClick={() => onHidden(!hidden)}><Icon name="eye" /></button>
      <button className={`btn icon-btn ${confirm ? "on" : ""}`} title={confirm ? "Click again to delete everything" : "Delete all drawings on this symbol (click twice)"}
        onClick={() => { if (confirm) { rc?.clearDrawings(); setConfirm(false); } else setConfirm(true); }}><Icon name="trash" /></button>
    </>
  );
}

// ------------------------------------------------------------ templates

// Drawing templates: named styles per tool, kept with the preferences. The
// starred one is the tool's default: new drawings start with it and "Apply
// default" applies it; with none starred that is the built-in style.
function TemplateMenu({ name, current, onApply, down, children }: {
  name: string; current: () => Opts; onApply: (style: Opts) => void; down?: boolean; children: ReactNode;
}) {
  const prefs = usePrefs();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // A click outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [open]);
  const templates = prefs.templates[name] || {}, def = prefs.templateDefault[name];
  const setTemplates = (next: Record<string, Record<string, unknown>>) => prefs.set({ templates: { ...prefs.templates, [name]: next } });
  const setDefault = (n: string | null) => {
    const next = { ...prefs.templateDefault };
    if (n) next[name] = n; else delete next[name];
    prefs.set({ templateDefault: next });
  };
  const apply = (style: Opts) => { onApply(clone(style)); setOpen(false); };
  const save = () => {
    const n = newName?.trim();
    if (!n) return;
    setTemplates({ ...templates, [n]: pick(name, current()) });
    setNewName(null); setOpen(false);
  };
  const remove = (n: string) => {
    const next = { ...templates };
    delete next[n];
    setTemplates(next);
    if (def === n) setDefault(null);
  };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <span onClick={() => { setOpen(!open); setNewName(null); }}>{children}</span>
      {open && (
        <div className={`pop ds-tpl ${down ? "down" : ""}`}>
          <button onClick={() => setNewName("")}>Save as…</button>
          {newName != null && (
            <div className="ds-tpl-new">
              <input autoFocus className="input sm" placeholder="Template name" maxLength={40} value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") save(); if (e.key === "Escape") setNewName(null); }} />
              <button className="btn primary sm" onClick={save}>Save</button>
            </div>
          )}
          <button onClick={() => apply(defaultStyle(name))}>Apply default <span className="muted">({def && templates[def] ? def : "built-in"})</span></button>
          {Object.keys(templates).length > 0 && <hr />}
          {Object.keys(templates).sort().map((n) => (
            <div key={n} className="ds-tpl-item">
              <button className={`star ${def === n ? "on" : ""}`} title={def === n ? "Default for new drawings (click to unset)" : "Set as default for new drawings"}
                onClick={() => setDefault(def === n ? null : n)}>{def === n ? "★" : "☆"}</button>
              <button onClick={() => apply(templates[n])}>{n}</button>
              <button className="del" title="Remove template" onClick={() => remove(n)}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ floating bar

export function DrawBar({ rc, d, onText, onSettings }: { rc: ReplayChart; d: Drawing; onText: () => void; onSettings: () => void }) {
  const [colors, setColors] = useState(false);
  const o = optsOf(d), pos = isPos(d.name);
  useEffect(() => setColors(false), [d.id]);
  return (
    <div className="drawbar" onMouseDown={(e) => e.stopPropagation()}>
      {!pos && (
        <div style={{ position: "relative" }}>
          <button className="db-btn" title="Colour" onClick={() => setColors(!colors)}><span className="db-sw" style={{ background: o.color }} /></button>
          {colors && (
            <div className="pop db-colors">
              {COLORS.map((c) => <button key={c} style={{ background: c }} title={c} onClick={() => { setStyle(rc, d, { color: c }); setColors(false); }} />)}
              <label title="Custom colour"><input type="color" value={/^#[0-9a-f]{6}$/i.test(o.color) ? o.color : COLORS[0]} onChange={(e) => setStyle(rc, d, { color: e.target.value })} /></label>
            </div>
          )}
        </div>
      )}
      {LINE_TOOLS.has(d.name) && (
        <>
          <select title="Line width" value={String(o.width)} onChange={(e) => setStyle(rc, d, { width: +e.target.value })}>
            {[1, 1.5, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
          </select>
          <select title="Line style" value={o.dash} onChange={(e) => setStyle(rc, d, { dash: e.target.value })}>
            {DASHES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </>
      )}
      {TEXT_TOOLS.has(d.name) && <button className="db-btn" title="Add text (or double-click the drawing)" onClick={onText}><b>T</b></button>}
      {!pos && (
        <TemplateMenu key={d.id} name={d.name} down current={() => optsOf(d)} onApply={(style) => setStyle(rc, d, style)}>
          <button className="db-btn db-tpl" title="Templates: save this style, apply one, set the default">Template ▾</button>
        </TemplateMenu>
      )}
      {!pos && <button className="db-btn" title="Settings (or double-click the drawing)" onClick={onSettings}><Icon name="gear" /></button>}
      <button className={`db-btn ${d.lock ? "on" : ""}`} title={d.lock ? "Unlock" : "Lock (stop accidental moves)"} onClick={() => rc.menuAction("lock", d.id)}><Icon name="lock" /></button>
      <button className="db-btn" title="Delete (Del)" onClick={() => rc.menuAction("remove", d.id)}><Icon name="trash" /></button>
    </div>
  );
}

// ------------------------------------------------------------ right-click menu

export function DrawMenu({ rc, id, x, y, onSettings, onClose }: { rc: ReplayChart; id: string; x: number; y: number; onSettings: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const d = rc.getDrawing(id);
  const [at, setAt] = useState({ x, y });
  useEffect(() => {
    const el = ref.current, wrap = el?.parentElement?.getBoundingClientRect();
    if (el && wrap) setAt({ x: Math.max(4, Math.min(x, wrap.width - el.offsetWidth - 4)), y: Math.max(4, Math.min(y, wrap.height - el.offsetHeight - 4)) });
    // (A right-click opens the menu in the same mousedown, so only left clicks close it.)
    const down = (e: MouseEvent) => { if (e.button === 0 && !ref.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [x, y, onClose]);
  if (!d) return null;
  const act = (a: string) => { onClose(); if (a === "settings") onSettings(); else rc.menuAction(a, id); };
  const item = (a: string, text: string) => <button key={a} onClick={() => act(a)}>{text}</button>;
  return (
    <div ref={ref} className="pop ds-menu" style={{ left: at.x, top: at.y }} onContextMenu={(e) => e.preventDefault()}>
      {!NO_STYLE.has(d.name) && [item("settings", "Settings…"), item("clone", "Clone")]}
      {item("front", "Bring to front")}
      {item("back", "Send to back")}
      {item("lock", d.lock ? "Unlock" : "Lock")}
      <hr />
      {item("remove", "Remove")}
    </div>
  );
}

// ------------------------------------------------------------ text box

export function TextEdit({ rc, id, onClose }: { rc: ReplayChart; id: string; onClose: () => void }) {
  const d = rc.getDrawing(id);
  const [v, setV] = useState(d?.text || "");
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const cur = rc.getDrawing(id);
    if (save && cur) rc.update({ ...cur, text: v.trim() || (cur.name === "note" ? "Note" : "") });
    onClose();
  };
  if (!d) return null;
  return (
    <div className="pop text-edit">
      <input autoFocus className="input sm" value={v} placeholder={d.name === "note" ? "Type a note, Enter to save" : "Text on the drawing, Enter to save"}
        onChange={(e) => setV(e.target.value)} onBlur={() => finish(true)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); }} />
    </div>
  );
}

// ------------------------------------------------------------ settings dialog

const WIDTHS = [1, 1.5, 2, 3, 4];
const DASHES: [string, string][] = [["solid", "── Solid"], ["dashed", "- - Dashed"], ["dotted", "··· Dotted"]];
const H: [string, string][] = [["left", "Left"], ["center", "Center"], ["right", "Right"]], V: [string, string][] = [["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"]];
const SIZES = [10, 11, 12, 14, 16, 20, 24, 28, 32, 40];

function Row({ name, children }: { name: string; children: ReactNode }) {
  return <div className="ds-row"><span className="ds-name">{name}</span><span className="ds-ctl">{children}</span></div>;
}

export function DrawingSettings({ rc, id, tz, onClose }: { rc: ReplayChart; id: string; tz: string; onClose: () => void }) {
  const [before] = useState(() => clone(rc.getDrawing(id)));
  // Older drawings lack the newer options: fill them with the defaults.
  const [draft, setDraft] = useState<Drawing | null>(() => { const d = rc.getDrawing(id); return d ? { ...clone(d), style: clone(optsOf(d)) } : null; });
  const [tab, setTab] = useState<"style" | "text" | "coords">("style");
  const prefs = usePrefs();
  if (!draft || !before) return null;
  const o = draft.style as Opts, name = draft.name;

  const show = (next: Drawing) => { setDraft(next); rc.update(next, false); };
  const set = (k: string, v: unknown) => show({ ...draft, style: { ...o, [k]: v } });
  const close = (ok: boolean) => {
    if (ok) {
      const d = { ...draft, text: draft.text?.trim() };
      rc.update(d, true);
      prefs.set({ toolStyle: { ...prefs.toolStyle, [name]: pick(name, o) } });
    } else rc.update(before, false);
    onClose();
  };

  const check = (k: string, text = "") => <label className="ds-check"><input type="checkbox" checked={!!o[k]} onChange={(e) => set(k, e.target.checked)} />{text}</label>;
  const color = (k: string, fb?: string) => <input type="color" title="Colour" value={o[k] || (fb && o[fb]) || "#787b86"} onChange={(e) => set(k, e.target.value)} />;
  const sel = (k: string, options: [string | number, string | number][], num = false) => (
    <select value={String(o[k])} onChange={(e) => set(k, num ? +e.target.value : e.target.value)}>
      {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
    </select>
  );
  const width = (k: string) => sel(k, WIDTHS.map((w) => [w, `${w}px`]), true);
  const dash = (k: string) => sel(k, DASHES);
  const alpha = (k: string) => <input type="range" min="0" max="100" title="Opacity" value={Math.round(o[k] * 100)} onChange={(e) => set(k, +e.target.value / 100)} />;

  let style: ReactNode;
  if (name === "segment") {
    style = <>
      <Row name="Line">{color("color")}{width("width")}{dash("dash")}</Row>
      <Row name="Extend">{check("extL", "Left")}{check("extR", "Right")}</Row>
      <Row name="Left end">{sel("leftEnd", [["normal", "Normal"], ["arrow", "Arrow"]])}</Row>
      <Row name="Right end">{sel("rightEnd", [["normal", "Normal"], ["arrow", "Arrow"]])}</Row>
      <Row name="">{check("midPoint", "Middle point")}</Row>
      <Row name="">{check("priceLabels", "Price labels")}</Row>
      <Row name="Stats">{sel("stats", [["hidden", "Hidden"], ["compact", "Compact"], ["values", "Values"]])}</Row>
      <Row name="Stats position">{sel("statsPos", H)}</Row>
      <Row name="">{check("statsAlways", "Always show stats")}</Row>
    </>;
  } else if (name === "rect") {
    style = <>
      <Row name="Border">{color("color")}{width("width")}{dash("dash")}</Row>
      <Row name="Background">{check("fill")}{color("fillColor", "color")}{alpha("fillAlpha")}</Row>
      <Row name="Middle line">{check("midLine")}{color("midColor", "color")}{width("midWidth")}{dash("midDash")}</Row>
      <Row name="Extend">{check("extL", "Left")}{check("extR", "Right")}</Row>
    </>;
  } else if (name === "fib") {
    const levels = o.levels as { v: number; c: string; on: boolean }[];
    const setLv = (i: number, change: Partial<{ v: number; c: string; on: boolean }>) => set("levels", levels.map((l, j) => (j === i ? { ...l, ...change } : l)));
    style = <>
      <Row name="Trend line">{check("trend")}{color("color")}{width("width")}{dash("dash")}</Row>
      <Row name="Levels line">{width("levelWidth")}{dash("levelDash")}</Row>
      <Row name="Extend">{sel("extend", [["none", "Don't extend"], ["left", "Left"], ["right", "Right"], ["both", "Both"]])}</Row>
      <div className="ds-levels">
        {levels.map((l, i) => (
          <div key={i} className="ds-lv">
            <input type="checkbox" checked={l.on} onChange={(e) => setLv(i, { on: e.target.checked })} />
            <LevelInput value={l.v} onChange={(v) => setLv(i, { v })} />
            <input type="color" value={l.c} onChange={(e) => setLv(i, { c: e.target.value })} />
          </div>
        ))}
      </div>
      <Row name="Use one color">{check("oneColorOn")}{color("oneColor")}</Row>
      <Row name="Background">{check("bg")}{alpha("bgAlpha")}</Row>
      <Row name="">{check("reverse", "Reverse")}</Row>
      <Row name="">{check("prices", "Prices")}</Row>
      <Row name="Levels">{check("showLevels")}{sel("levelsAs", [["values", "Values"], ["percents", "Percents"]])}</Row>
      <Row name="Labels">{sel("labelH", H)}{sel("labelV", V)}</Row>
      <Row name="Font size">{sel("fontSize", SIZES.map((s) => [s, s]), true)}</Row>
    </>;
  } else {
    const plain = name === "note" || name === "measure";
    style = <Row name={name === "note" ? "Background" : "Line"}>{color("color")}{!plain && width("width")}{!plain && dash("dash")}</Row>;
  }

  const text = <>
    <textarea className="ds-text" rows={3} placeholder="Add text" value={draft.text || ""} onChange={(e) => show({ ...draft, text: e.target.value })} />
    <Row name="Style">
      {color("textColor", name === "note" ? undefined : "color")}
      {sel("fontSize", SIZES.map((s) => [s, s]), true)}
      <label className="ds-tog" title="Bold"><input type="checkbox" checked={!!o.bold} onChange={(e) => set("bold", e.target.checked)} /><b>B</b></label>
      <label className="ds-tog" title="Italic"><input type="checkbox" checked={!!o.italic} onChange={(e) => set("italic", e.target.checked)} /><i>I</i></label>
    </Row>
    {name !== "note" && (
      <Row name="Alignment">
        {sel("vAlign", name === "rect" ? V : [["top", "Above line"], ["middle", "On line"], ["bottom", "Below line"]])}
        {sel("hAlign", H)}
      </Row>
    )}
  </>;

  const setPt = (i: number, change: Partial<{ timestamp: number; value: number }>) => show({ ...draft, points: draft.points.map((p, j) => (j === i ? { ...p, ...change } : p)) });
  const coords = draft.points.map((p, i) => (
    <Row key={i} name={`#${i + 1}`}>
      <LevelInput value={p.value} title="Price" onChange={(v) => setPt(i, { value: v })} />
      <input type="datetime-local" title={`Time (${tz})`} defaultValue={toLocal(p.timestamp, tz)} onChange={(e) => { if (e.target.value) setPt(i, { timestamp: fromLocal(e.target.value, tz) }); }} />
    </Row>
  ));

  const tabs: ["style" | "text" | "coords", string][] = [["style", "Style"], ...(TEXT_TOOLS.has(name) ? [["text", "Text"] as ["text", string]] : []), ["coords", "Coordinates"]];
  return (
    <div className="ds" onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}>
      <div className="ds-box" role="dialog" aria-modal="true"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close(false);
          else if (e.key === "Enter" && !/TEXTAREA|BUTTON/.test((e.target as HTMLElement).tagName)) close(true);
        }}>
        <div className="ds-head"><b>{toolLabel(name)}</b><button className="db-btn" title="Close" onClick={() => close(false)}>✕</button></div>
        <div className="ds-tabs">{tabs.map(([k, t]) => <button key={k} className={k === tab ? "on" : ""} onClick={() => setTab(k)}>{t}</button>)}</div>
        <div className="ds-body">{tab === "style" ? style : tab === "text" ? text : coords}</div>
        <div className="ds-foot">
          <TemplateMenu name={name} current={() => o} onApply={(style) => show({ ...draft, style: { ...o, ...style } })}>
            <button className="btn outline">Template ▾</button>
          </TemplateMenu>
          <span style={{ flex: 1 }} />
          <button className="btn outline" onClick={() => close(false)}>Cancel</button>
          <button className="btn primary" onClick={() => close(true)}>Ok</button>
        </div>
      </div>
    </div>
  );
}

// A number box that lets you type freely and only passes on real numbers.
function LevelInput({ value, onChange, title }: { value: number; onChange: (v: number) => void; title?: string }) {
  const [s, setS] = useState(String(value));
  useEffect(() => { if (parseFloat(s) !== value) setS(String(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return <input type="number" step="any" title={title} value={s} onChange={(e) => { setS(e.target.value); const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(v); }} />;
}
