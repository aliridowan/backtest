const dtf = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string) {
  let f = dtf.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    dtf.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(ms)) p[type] = value;
  return p;
}

// "Wed 15 Oct 25" (en-GB says "Sept", so months are cut to three letters).
export function fmtDay(sec: number, tz: string) {
  const p = parts(sec * 1000, tz);
  return `${p.weekday} ${p.day} ${p.month.slice(0, 3)} ${p.year}`;
}
export function fmtTime(sec: number, tz: string) {
  const p = parts(sec * 1000, tz);
  return `${p.hour}:${p.minute}`;
}
export const fmtDateTime = (sec: number, tz: string) => `${fmtDay(sec, tz)} ${fmtTime(sec, tz)}`;

export const fmtMoney = (v: number, sign = false) =>
  (sign && v > 0 ? "+" : v < 0 ? "−" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtPct = (v: number, sign = true) => (sign && v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%";
export const fmtR = (v: number | null) => (v == null ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "R");
export const fmtPrice = (v: number, digits: number) => v.toFixed(digits);
export const pnlClass = (v: number) => (v > 0 ? "pos" : v < 0 ? "neg" : "");

export function fmtDuration(min: number) {
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`;
  return `${Math.floor(min / 1440)}d ${Math.round((min % 1440) / 60)}h`;
}

// <input type="date"> value <-> seconds at 00:00 UTC.
export const dateInput = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
export const fromDateInput = (v: string) => Date.parse(v + "T00:00:00Z") / 1000;
