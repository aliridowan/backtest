"use client";

// Order form like Exness's terminal: pick Sell or Buy (that only chooses the
// side), set the volume, take profit and stop loss, then confirm.

import { useEffect, useRef, useState } from "react";
import { digits, lotsForRisk, pipSize, pnlUsd } from "@/lib/instruments";
import { fmtMoney } from "@/lib/format";
import { usePrefs } from "@/lib/store";
import type { OrderType, Side } from "@/lib/types";

// sl / tp are prices; null = not set.
export type OrderRequest = { side: Side; type: OrderType; price: number | null; sl: number | null; tp: number | null; lots: number; setup?: string; checks?: string[] };
// What the chart shows while an order is being set up (prices).
export type OrderDraft = { side: Side; type: OrderType; entry: number; sl: number | null; tp: number | null; lots: number };
// A preview line dragged on the chart.
export type DraftDrag = { kind: "entry" | "sl" | "tp"; price: number; n: number };

type Props = {
  symbol: string;
  bid: number | null;
  spread: number; // price
  rate: number; // quote -> USD
  balance: number;
  riskPct: number;
  commission: number; // USD per lot, round turn
  drag: DraftDrag | null;
  onDraft: (d: OrderDraft | null) => void;
  onPlace: (o: OrderRequest) => Promise<string | null>;
  onHide: () => void;
  onEditSetups: () => void;
};

type Unit = "pips" | "price";
type SizeMode = "lots" | "risk" | "money";
const num = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// [−] value [+], like Exness's inputs.
function Stepper({ value, onChange, onStep, placeholder, label }: { value: string; onChange: (v: string) => void; onStep: (dir: 1 | -1) => void; placeholder?: string; label: string }) {
  return (
    <div className="stepper">
      <button type="button" tabIndex={-1} aria-label={`Decrease ${label}`} onClick={() => onStep(-1)}>−</button>
      <input className="num" inputMode="decimal" value={value} placeholder={placeholder} aria-label={label} onChange={(e) => onChange(e.target.value)} />
      <button type="button" tabIndex={-1} aria-label={`Increase ${label}`} onClick={() => onStep(1)}>+</button>
    </div>
  );
}

export default function OrderPanel({ symbol, bid, spread, rate, balance, riskPct, commission, drag, onDraft, onPlace, onHide, onEditSetups }: Props) {
  const d = digits(symbol), pip = pipSize(symbol);
  const [side, setSide] = useState<Side | null>(null);
  const [tab, setTab] = useState<"market" | "pending">("market");
  const [price, setPrice] = useState("");
  const [sizeMode, setSizeMode] = useState<SizeMode>("lots");
  const [lotsIn, setLotsIn] = useState("0.10");
  const [riskIn, setRiskIn] = useState(String(riskPct));
  const [moneyIn, setMoneyIn] = useState("100");
  const [tpIn, setTpIn] = useState(""), [tpUnit, setTpUnit] = useState<Unit>("pips");
  const [slIn, setSlIn] = useState(""), [slUnit, setSlUnit] = useState<Unit>("pips");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Journal: the setup this trade is taken with and its ticked checklist items.
  const setups = usePrefs((p) => p.setups);
  const [setupName, setSetupName] = useState("");
  const [checks, setChecks] = useState<string[]>([]);
  const setup = setups.find((x) => x.name === setupName);

  useEffect(() => { setPrice(""); setError(""); setSide(null); setTpIn(""); setSlIn(""); }, [symbol]);
  useEffect(() => { setRiskIn(String(riskPct)); }, [riskPct]);

  const ask = bid != null ? bid + spread : null;
  const s: Side = side ?? "buy"; // sums before a side is picked use the buy side
  const dir = s === "buy" ? 1 : -1;
  const market = s === "buy" ? ask : bid;
  const entry = tab === "market" ? market : num(price);
  // A pending order is a limit or a stop depending on where its price is.
  const type: OrderType = tab === "market" ? "market"
    : entry == null || market == null ? "limit"
    : (s === "buy" ? entry < market : entry > market) ? "limit" : "stop";

  // Stop and target as prices, from pips (away from the entry) or a price typed in.
  const level = (text: string, unit: Unit, sign: 1 | -1) => {
    const v = num(text);
    if (v == null || entry == null) return null;
    return unit === "price" ? v : entry + sign * dir * v * pip;
  };
  const slPrice = level(slIn, slUnit, -1), tpPrice = level(tpIn, tpUnit, 1);
  const slDist = slPrice != null && entry != null ? (entry - slPrice) * dir : null; // > 0 on the losing side
  const tpDist = tpPrice != null && entry != null ? (tpPrice - entry) * dir : null;

  const lots = sizeMode === "lots" ? num(lotsIn) ?? 0
    : slDist && slDist > 0 ? lotsForRisk(symbol, sizeMode === "risk" ? (balance * (num(riskIn) ?? 0)) / 100 : num(moneyIn) ?? 0, slDist, rate, commission) : 0;
  const riskUsd = slDist != null && lots ? pnlUsd(symbol, slDist, lots, rate) + commission * lots : null;
  const rewardUsd = tpDist != null && lots ? pnlUsd(symbol, tpDist, lots, rate) - commission * lots : null;

  // Preview lines on the chart while a side is picked.
  const last = useRef("");
  useEffect(() => {
    const draft = side && entry != null && entry > 0 ? { side, type, entry, sl: slPrice, tp: tpPrice, lots } : null;
    const key = JSON.stringify(draft);
    if (key !== last.current) { last.current = key; onDraft(draft); }
  });

  // A preview line dragged on the chart writes its price back into the form.
  useEffect(() => {
    if (!drag || entry == null) return;
    const p = drag.price;
    const back = (unit: Unit, sign: 1 | -1) => (unit === "price" ? p.toFixed(d) : Math.max(0, ((p - entry) * dir * sign) / pip).toFixed(1));
    if (drag.kind === "entry") { setTab("pending"); setPrice(p.toFixed(d)); }
    else if (drag.kind === "sl") setSlIn(back(slUnit, -1));
    else setTpIn(back(tpUnit, 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.n]);

  // Switching pips <-> price keeps the same level.
  const switchUnit = (which: "sl" | "tp", unit: Unit) => {
    const [text, cur, set, setU, sign] = which === "sl" ? [slIn, slUnit, setSlIn, setSlUnit, -1 as const] : [tpIn, tpUnit, setTpIn, setTpUnit, 1 as const];
    if (unit === cur) return;
    const lvl = level(text, cur, sign);
    setU(unit);
    if (lvl == null || entry == null) return set("");
    set(unit === "price" ? lvl.toFixed(d) : Math.max(0, ((lvl - entry) * dir * sign) / pip).toFixed(1));
  };
  // + / − on an empty stop or target starts it 10 pips away.
  const stepLevel = (which: "sl" | "tp", k: 1 | -1) => {
    const [text, unit, set, sign] = which === "sl" ? [slIn, slUnit, setSlIn, -1 as const] : [tpIn, tpUnit, setTpIn, 1 as const];
    const v = num(text);
    if (unit === "pips") return set(Math.max(0, (v ?? 9) + k).toFixed(1));
    if (entry == null) return;
    set((v == null ? entry + sign * dir * 10 * pip : v + k * pip).toFixed(d));
  };
  const stepPrice = (k: 1 | -1) => { const v = num(price) ?? market; if (v != null) setPrice((v + k * pip).toFixed(d)); };
  const stepSize = (k: 1 | -1) => {
    if (sizeMode === "lots") setLotsIn(Math.max(0.01, (num(lotsIn) ?? 0) + k * 0.01).toFixed(2));
    else if (sizeMode === "risk") setRiskIn(Math.max(0.1, (num(riskIn) ?? 0) + k * 0.1).toFixed(1));
    else setMoneyIn(String(Math.max(1, (num(moneyIn) ?? 0) + k * 10)));
  };

  const confirm = async () => {
    if (!side) return;
    setError("");
    if (entry == null || !(entry > 0)) return setError(tab === "market" ? "No price yet." : "Enter the open price.");
    if (slIn.trim() && slPrice == null) return setError("Stop loss is not a number.");
    if (tpIn.trim() && tpPrice == null) return setError("Take profit is not a number.");
    if (slDist != null && !(slDist > 0)) return setError(`The stop loss must be ${side === "buy" ? "below" : "above"} the open price.`);
    if (tpDist != null && !(tpDist > 0)) return setError(`The take profit must be ${side === "buy" ? "above" : "below"} the open price.`);
    if (sizeMode !== "lots" && slPrice == null) return setError("Sizing by risk needs a stop loss.");
    if (!(lots >= 0.01)) return setError("Volume must be at least 0.01 lots.");
    setBusy(true);
    const err = await onPlace({ side, type, price: tab === "market" ? null : entry, sl: slPrice, tp: tpPrice, lots: Math.round(lots * 100) / 100,
      ...(setup ? { setup: setup.name, checks: checks.filter((c) => setup.checklist.includes(c)) } : {}) });
    setBusy(false);
    if (err) setError(err);
    else { setSide(null); setChecks([]); }
  };

  const fmt = (v: number | null) => (v == null ? "—" : v.toFixed(d));
  const unitSel = (which: "sl" | "tp", unit: Unit) => (
    <select className="input sm" value={unit} onChange={(e) => switchUnit(which, e.target.value as Unit)} aria-label={`${which === "sl" ? "Stop loss" : "Take profit"} unit`}>
      <option value="pips">Pips</option>
      <option value="price">Price</option>
    </select>
  );
  const typeLabel = `${s === "buy" ? "Buy" : "Sell"}${type === "market" ? "" : " " + type[0].toUpperCase() + type.slice(1)}`;

  return (
    <div className="order">
      <div className="sheet-handle" />
      <div className="order-head">
        <b>{symbol}</b>
        <button className="btn icon-btn" title="Hide the order panel" onClick={onHide}>✕</button>
      </div>

      <div className="quote num">
        <button className={`q sell ${side === "sell" ? "on" : ""} ${side === "buy" ? "dim" : ""}`} onClick={() => { setSide(side === "sell" ? null : "sell"); setError(""); }}>
          <span>Sell</span><b>{fmt(bid)}</b>
        </button>
        <span className="spread" title="Spread">{(spread / pip).toFixed(1)}</span>
        <button className={`q buy ${side === "buy" ? "on" : ""} ${side === "sell" ? "dim" : ""}`} onClick={() => { setSide(side === "buy" ? null : "buy"); setError(""); }}>
          <span>Buy</span><b>{fmt(ask)}</b>
        </button>
      </div>

      <div className="seg">
        <button className={tab === "market" ? "on" : ""} onClick={() => setTab("market")}>Market</button>
        <button className={tab === "pending" ? "on" : ""} onClick={() => { setTab("pending"); if (!price && market != null) setPrice(market.toFixed(d)); }}>Pending</button>
      </div>

      {tab === "pending" && (
        <div className="field">
          <span>Open price {side && entry != null && <em className="muted">· {typeLabel}</em>}</span>
          <Stepper label="Open price" value={price} onChange={setPrice} onStep={stepPrice} />
        </div>
      )}

      <div className="field">
        <span>Volume</span>
        <div className="seg">
          <button className={sizeMode === "lots" ? "on" : ""} onClick={() => setSizeMode("lots")}>Lots</button>
          <button className={sizeMode === "risk" ? "on" : ""} onClick={() => setSizeMode("risk")}>Risk %</button>
          <button className={sizeMode === "money" ? "on" : ""} onClick={() => setSizeMode("money")}>Risk $</button>
        </div>
        <div className="with-unit">
          {sizeMode === "lots" && <Stepper label="Lots" value={lotsIn} onChange={setLotsIn} onStep={stepSize} />}
          {sizeMode === "risk" && <Stepper label="Risk percent" value={riskIn} onChange={setRiskIn} onStep={stepSize} />}
          {sizeMode === "money" && <Stepper label="Risk in USD" value={moneyIn} onChange={setMoneyIn} onStep={stepSize} />}
          <span className="unit">{sizeMode === "lots" ? "lots" : sizeMode === "risk" ? "%" : "USD"}</span>
        </div>
        {sizeMode !== "lots" && <span className="muted num" style={{ fontSize: 12 }}>{slPrice == null ? "Set a stop loss to size the trade." : `= ${lots ? lots.toFixed(2) : "—"} lots`}</span>}
      </div>

      <div className="field">
        <span>Take profit</span>
        <div className="with-unit">
          <Stepper label="Take profit" value={tpIn} onChange={setTpIn} onStep={(k) => stepLevel("tp", k)} placeholder="Not set" />
          {unitSel("tp", tpUnit)}
        </div>
        {tpPrice != null && <span className="muted num" style={{ fontSize: 12 }}>{tpUnit === "pips" ? fmt(tpPrice) : `${((tpDist ?? 0) / pip).toFixed(1)} pips`}{rewardUsd != null && <span className="pos"> · {fmtMoney(rewardUsd, true)}</span>}</span>}
      </div>

      <div className="field">
        <span>Stop loss</span>
        <div className="with-unit">
          <Stepper label="Stop loss" value={slIn} onChange={setSlIn} onStep={(k) => stepLevel("sl", k)} placeholder="Not set" />
          {unitSel("sl", slUnit)}
        </div>
        {slPrice != null && <span className="muted num" style={{ fontSize: 12 }}>{slUnit === "pips" ? fmt(slPrice) : `${((slDist ?? 0) / pip).toFixed(1)} pips`}{riskUsd != null && <span className="neg"> · {fmtMoney(-riskUsd, true)}</span>}</span>}
      </div>

      <div className="field">
        <span style={{ display: "flex", justifyContent: "space-between" }}>Setup <button type="button" className="btn sm" style={{ height: "auto", padding: 0, color: "var(--muted)" }} onClick={onEditSetups}>Edit setups</button></span>
        <select className="input" value={setupName} onChange={(e) => { setSetupName(e.target.value); setChecks([]); }} aria-label="Setup">
          <option value="">No setup</option>
          {setups.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
        {setup && setup.checklist.length > 0 && (
          <div className="checklist">
            {setup.checklist.map((c) => (
              <label key={c} className="row-check"><input type="checkbox" checked={checks.includes(c)} onChange={(e) => setChecks(e.target.checked ? [...checks, c] : checks.filter((x) => x !== c))} /> {c}</label>
            ))}
            <span className={`muted ${checks.length < setup.checklist.length ? "warn" : ""}`} style={{ fontSize: 12 }}>
              {checks.length} / {setup.checklist.length} ticked{checks.length < setup.checklist.length ? " · not every rule is met" : ""}
            </span>
          </div>
        )}
      </div>

      <div className="summary num">
        <span>Volume</span><span>{lots ? `${lots.toFixed(2)} lots` : "—"}</span>
        <span>Risk</span><span className="neg">{riskUsd != null ? `${fmtMoney(riskUsd)} (${((riskUsd / balance) * 100).toFixed(2)}%)` : "—"}</span>
        <span>Reward</span><span className="pos">{rewardUsd != null ? fmtMoney(rewardUsd) : "—"}</span>
        <span>R:R</span><span>{slDist && tpDist ? (tpDist / slDist).toFixed(2) : "—"}</span>
        <span>Commission</span><span>{lots ? fmtMoney(commission * lots) : "—"}</span>
      </div>

      {side ? (
        <div style={{ display: "grid", gap: 6 }}>
          <button className={`confirm ${side}`} disabled={busy} onClick={confirm}>
            Confirm {typeLabel} {lots ? lots.toFixed(2) : "—"} lots
          </button>
          <button className="btn outline" onClick={() => { setSide(null); setError(""); }}>Cancel</button>
        </div>
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 12, textAlign: "center" }}>Pick Sell or Buy above to set up the order.</p>
      )}
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
      <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
        Drag the entry, SL and TP lines on the chart to set them. Fills, stops and targets are checked on every 1-minute candle; if a stop and a target are hit in the same minute, the stop counts.
      </p>
    </div>
  );
}
