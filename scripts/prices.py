#!/usr/bin/env python3
"""Download 1-minute price data (forex from 2015, gold from 2009, BTC from
Aug 2017, oil from Oct 2021, US30 / NAS100 from 2012) and build every
timeframe for BacktestMind (started as a copy of tradingMind/tools/prices.py).

    python3 scripts/prices.py fetch      download what's missing (safe to re-run)
    python3 scripts/prices.py build      build data/market/ from the downloads
    python3 scripts/prices.py            both
    python3 scripts/prices.py fetch US30 NAS100   only these symbols (any command;
                                         build keeps the others as they are)

Sources (free, no API key):
- US oil (WTI) and the US30 / NAS100 indices: Dukascopy's chart feed for every
  month (histdata's WTI has gaps and it has no Dow), _work/prices/raw/<SYM>/duka-<YYYY-MM>.json.
- Forex pairs + gold: histdata.com 1-minute bars, one zip per symbol per year,
  and per month for the current year (_work/prices/raw/<SYM>/<YYYY>.zip or
  <YYYY-MM>.zip). Times are New York local time (UTC-5, UTC-4 in summer).
  The days these archives don't have yet come from Dukascopy's chart feed
  (_work/prices/raw/<SYM>/recent.json, rewritten on every fetch). Months where
  histdata misses hours of trading (most of Feb-Jul 2023, a few single days)
  are downloaded from Dukascopy too (duka-<YYYY-MM>.json) and fill the missing
  minutes; gaps.json remembers which months each zip lacks.
- BTC: Binance spot BTCUSDT 1m klines from data.binance.vision, one zip per
  month (_work/prices/raw/BTCUSD/<YYYY-MM>.zip), and Binance's public API for
  the latest day (recent.json).

Output (data/market/, served as public/market and read by src/lib/market.ts):
- index.json: symbols, price scale, timeframes and their chunk files
- <SYM>/<TF>/<chunk>.bin: candles, 24 bytes each, little-endian:
  int32 time (unix seconds, candle open), int32 open, high, low, close
  (price * scale), float32 volume
"""
import collections
import concurrent.futures as cf
import csv
import datetime as dt
import io
import json
import re
import os
import shutil
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from array import array

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "_work", "prices", "raw")
OUT = os.path.join(ROOT, "data", "market")
START = dt.date(2021, 10, 1)  # US oil
FOREX_FROM, GOLD_FROM = 2015, 2009  # first histdata year
BTC_START = dt.date(2017, 8, 1)  # Binance opened BTCUSDT in Aug 2017

CCY = ["EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF", "JPY"]  # market quoting order
MAJORS = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"]
PAIRS = [a + b for i, a in enumerate(CCY) for b in CCY[i + 1:]]
MINORS = [p for p in PAIRS if p not in MAJORS]

# name -> (group, price scale, display digits)
SYMBOLS = {}
for p in MAJORS + MINORS:
    jpy = p.endswith("JPY")
    SYMBOLS[p] = ("Majors" if p in MAJORS else "Minors", 1000 if jpy else 100000, 3 if jpy else 5)
SYMBOLS["XAUUSD"] = ("Metals", 1000, 2)
SYMBOLS["USOIL"] = ("Energies", 1000, 3)
SYMBOLS["BTCUSD"] = ("Crypto", 100, 2)
SYMBOLS["US30"] = ("Indices", 100, 2)
SYMBOLS["NAS100"] = ("Indices", 100, 2)

# Our name -> Dukascopy's instrument, where it differs; DUKA_ONLY symbols take
# all their history from Dukascopy, from the first day of their month here.
DUKASCOPY = {"USOIL": "LIGHT.CMD/USD", "US30": "USA30.IDX/USD", "NAS100": "USATECH.IDX/USD"}
DUKA_ONLY = {"USOIL": START, "US30": dt.date(2012, 4, 1), "NAS100": dt.date(2012, 1, 1)}

ONLY = set()  # symbols named on the command line (empty = all)

# timeframe -> (seconds, chunk period). Chunks keep every file around 1 MB.
TFS = {
    "M1": (60, "month"), "M5": (300, "quarter"), "M15": (900, "year"), "M30": (1800, "year"),
    "H1": (3600, "all"), "H4": (14400, "all"), "D1": (86400, "all"),
    "W1": (604800, "all"), "MN": (0, "all"),
}


# ---------------------------------------------------------------- fetch

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64)"}


def get(url, data=None, headers=None, tries=6):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return b""
        except Exception:
            pass
        time.sleep(3 * (i + 1))
    raise RuntimeError(f"failed: {url}")


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".part", "wb") as f:
        f.write(data)
    os.replace(path + ".part", path)


def histdata(sym, year, month=None, refresh=False):
    """One year (or one month of the current year) of 1-minute bars."""
    path = os.path.join(RAW, sym, f"{year}-{month:02d}.zip" if month else f"{year}.zip")
    if os.path.exists(path) and not refresh:
        return 0
    # The download is a form post that needs the token printed on the page.
    page = f"https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/{sym.lower()}/{year}"
    if month:
        page += f"/{month}"
    html = get(page).decode("utf-8", "replace")
    form = dict(re.findall(r'name="(\w+)" id="\w+" value="([^"]*)"', html))
    if not form.get("tk"):
        return 0  # not published (yet)
    body = "&".join(f"{k}={form[k]}" for k in ("tk", "date", "datemonth", "platform", "timeframe", "fxpair"))
    data = get("https://www.histdata.com/get.php", body.encode(),
               {"Referer": page, "Content-Type": "application/x-www-form-urlencoded"})
    time.sleep(2)  # go easy on histdata
    if data[:2] == b"PK":
        save(path, data)
        return 1
    return 0


def binance_month(ym, daily=False):
    path = os.path.join(RAW, "BTCUSD", f"{ym}.zip")
    if os.path.exists(path):
        return 0
    kind = "daily" if daily else "monthly"
    data = get(f"https://data.binance.vision/data/spot/{kind}/klines/BTCUSDT/1m/BTCUSDT-1m-{ym}.zip")
    if data:
        save(path, data)
    return 1


def recent(sym):
    """1-minute bars from the start of last month (early in a month) or this
    month until now, as [[ms, open, high, low, close, volume], ...]."""
    now = dt.datetime.now(dt.timezone.utc)
    since = dt.datetime(now.year, now.month, 1, tzinfo=dt.timezone.utc)
    if now.day <= 10:
        since = (since - dt.timedelta(1)).replace(day=1)
    rows = bars_between(sym, int(since.timestamp()) * 1000, now.timestamp() * 1000 - 60_000)
    save(os.path.join(RAW, sym, "recent.json"), json.dumps(rows).encode())
    return 1


def duka_month(sym, ym):
    """One finished month from Dukascopy's chart feed."""
    path = os.path.join(RAW, sym, f"duka-{ym}.json")
    if os.path.exists(path):
        return 0
    y, m = map(int, ym.split("-"))
    a = dt.datetime(y, m, 1, tzinfo=dt.timezone.utc)
    b = dt.datetime(y + m // 12, m % 12 + 1, 1, tzinfo=dt.timezone.utc)
    rows = bars_between(sym, int(a.timestamp()) * 1000, int(b.timestamp()) * 1000)
    save(path, json.dumps([r for r in rows if r[0] < b.timestamp() * 1000]).encode())
    return 1


def bars_between(sym, t, end):
    rows = []
    while t < end:
        if sym == "BTCUSD":
            raw = json.loads(get(f"https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime={t}&limit=1000"))
            batch = [[k[0], float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])] for k in raw]
        else:
            js = get(f"https://freeserv.dukascopy.com/2.0/?path=chart/json3&instrument={DUKASCOPY.get(sym, sym[:3] + '/' + sym[3:])}"
                     f"&offer_side=B&interval=1MIN&splits=true&stocks=true&limit=10000&time_direction=N"
                     f"&timestamp={t}&jsonp=_cb", headers={"Referer": "https://www.dukascopy.com/"}).decode()
            batch = json.loads(js[js.index("(") + 1:js.rindex(")")])
        batch = [r for r in batch if r[0] >= t]
        if not batch:
            break
        rows += batch
        t = batch[-1][0] + 60_000
        time.sleep(0.5)
    return rows


def months_since(start, today):
    """"YYYY-MM" of every finished month from `start` to before `today`'s month."""
    out, y, m = [], start.year, start.month
    while (y, m) < (today.year, today.month):
        out.append(f"{y}-{m:02d}")
        y, m = y + m // 12, m % 12 + 1
    return out


def fetch():
    today = dt.datetime.now(dt.timezone.utc).date()
    days = [START + dt.timedelta(n) for n in range((today - START).days)]
    syms = [s for s in SYMBOLS if not ONLY or s in ONLY]
    jobs = []
    for sym in syms:
        if sym == "BTCUSD":
            continue
        if sym in DUKA_ONLY:
            jobs += [(duka_month, sym, m) for m in months_since(DUKA_ONLY[sym], today)]
            continue
        jobs += [(histdata, sym, y) for y in range(GOLD_FROM if sym == "XAUUSD" else FOREX_FROM, today.year)]
        # The current year comes in monthly files; the latest month keeps growing.
        jobs += [(histdata, sym, today.year, m, m >= today.month - 1) for m in range(1, today.month + 1)]
    if "BTCUSD" in syms:
        this_month = today.strftime("%Y-%m")
        jobs += [(binance_month, m) for m in months_since(BTC_START, today)]
        # The current month isn't published as a monthly zip yet: use daily zips.
        jobs += [(binance_month, d.isoformat(), True) for d in days if d.strftime("%Y-%m") == this_month]

    jobs += [(recent, sym) for sym in syms]
    run(jobs)

    # histdata's gaps, now that its zips are here
    fills = [(duka_month, sym, m) for sym in syms if sym != "BTCUSD" and sym not in DUKA_ONLY
             for m in gap_months(sym)]
    print(f"==> Filling histdata's gaps from Dukascopy", flush=True)
    run(fills)


def run(jobs):
    print(f"==> {len(jobs)} files to check", flush=True)
    done = got = failed = 0
    t0 = time.time()
    # Binance is fast; histdata and Dukascopy get only a few requests at a time.
    # A failed file (site down or throttling us) is skipped; the next run tries it again.
    with cf.ThreadPoolExecutor(8) as bpool, cf.ThreadPoolExecutor(2) as hpool:
        futs = [(bpool if j[0] is binance_month else hpool).submit(j[0], *j[1:]) for j in jobs]
        for fut in cf.as_completed(futs):
            try:
                got += fut.result()
            except Exception as e:
                failed += 1
                print(f"   {e}", flush=True)
            done += 1
            if done % 25 == 0 or done == len(jobs):
                print(f"   {done}/{len(jobs)} checked, {got} downloaded, {time.time() - t0:.0f}s", flush=True)
    if failed:
        print(f"==> {failed} files failed; run fetch again later to get them", flush=True)


def holiday(d):
    """Days the market is shut or half open: Christmas, New Year, Good Friday,
    the Friday after Thanksgiving."""
    if (d.month, d.day) in ((12, 24), (12, 25), (12, 26), (12, 31), (1, 1), (1, 2)):
        return True
    y = d.year  # Easter Sunday (anonymous Gregorian algorithm)
    a, b, c = y % 19, y // 100, y % 100
    h = (19 * a + b - b // 4 - (b - (b + 8) // 25 + 1) // 3 + 15) % 30
    l = (32 + 2 * (b % 4) + 2 * (c // 4) - h - c % 4) % 7
    n = h + l - 7 * ((a + 11 * h + 22 * l) // 451) + 114
    easter = dt.date(y, n // 31, n % 31 + 1)
    thanksgiving = dt.date(y, 11, 1) + dt.timedelta((3 - dt.date(y, 11, 1).weekday()) % 7 + 21)
    return d in (easter - dt.timedelta(2), thanksgiving + dt.timedelta(1))


def gap_months(sym):
    """Finished months where histdata misses hours of a trading day. Candles per
    trading day are counted once per zip (again when its size changes) and kept
    in gaps.json; a day can span two zips, so the counts are added up."""
    folder = os.path.join(RAW, sym)
    path = os.path.join(folder, "gaps.json")
    seen = json.load(open(path)) if os.path.exists(path) else {}
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".zip"):
            continue
        size = os.path.getsize(os.path.join(folder, name))
        if seen.get(name, [None])[0] == size:
            continue
        count = collections.Counter()  # trading day (17:00 New York to 17:00) -> candles
        with zipfile.ZipFile(os.path.join(folder, name)) as z:
            for member in z.namelist():
                if member.endswith(".csv"):
                    for line in io.TextIOWrapper(z.open(member)):
                        day = dt.date(int(line[:4]), int(line[4:6]), int(line[6:8]))
                        count[str(day + dt.timedelta(int(line[9:11]) >= 17))] += 1
        seen[name] = [size, count]
    save(path, json.dumps(seen).encode())
    count = collections.Counter()
    for _, c in seen.values():
        count.update(c)
    months = set()
    full = 1100 if sym == "XAUUSD" else 1300  # gold closes early on US holidays
    if count:
        first, last = dt.date.fromisoformat(min(count)), dt.date.fromisoformat(max(count))
        for n in range(1, (last - first).days):  # the first and last day may be partial
            d = first + dt.timedelta(n)
            if d.weekday() < 5 and count[str(d)] < full and not holiday(d):
                months.add(d.strftime("%Y-%m"))
    this_month = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")
    return sorted(months - {this_month})


# ---------------------------------------------------------------- read raw

def new_bars():
    return tuple(array("i") for _ in range(5)) + (array("f"),)


def read_histdata(sym):
    """All 1-minute candles for a histdata symbol as 6 parallel arrays."""
    scale = SYMBOLS[sym][1]
    rows = {}
    days = {}  # "20230101" -> unix time of that day's midnight in New York
    folder = os.path.join(RAW, sym)
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".zip"):
            continue
        with zipfile.ZipFile(os.path.join(folder, name)) as z:
            for member in z.namelist():
                if not member.endswith(".csv"):
                    continue
                for line in io.TextIOWrapper(z.open(member)):
                    # 20230101 170400;1.069700;1.069740;1.069700;1.069700;0
                    d, op, hi, lo, cl, _ = line.split(";")
                    day = days.get(d[:8])
                    if day is None:
                        day = int(dt.datetime(int(d[:4]), int(d[4:6]), int(d[6:8]),
                                              tzinfo=dt.timezone.utc).timestamp()) + 5 * 3600
                        if ny_dst(day + 12 * 3600):
                            day -= 3600
                        days[d[:8]] = day
                    ts = day + int(d[9:11]) * 3600 + int(d[11:13]) * 60
                    rows[ts] = (round(float(op) * scale), round(float(hi) * scale),
                                round(float(lo) * scale), round(float(cl) * scale))
    for name in sorted(os.listdir(folder)):
        if name.startswith("duka-"):  # Dukascopy months that fill histdata's missing minutes
            for r in json.load(open(os.path.join(folder, name))):
                if r[5] > 0:
                    rows.setdefault(r[0] // 1000, tuple(round(x * scale) for x in r[1:5]))
    last = max(rows, default=0)
    for ts, op, hi, lo, cl, _ in read_recent(sym):
        if ts > last:
            rows[ts] = (round(op * scale), round(hi * scale), round(lo * scale), round(cl * scale))
    t, o, h, l, c, v = new_bars()
    for ts in sorted(rows):
        r = rows[ts]
        t.append(ts); o.append(r[0]); h.append(r[1]); l.append(r[2]); c.append(r[3]); v.append(0)
    return t, o, h, l, c, v


def real(r):
    """A Dukascopy candle that traded: it has volume or moved (index volumes are
    sometimes 0 on moving minutes). Flat zero-volume ones fill closed hours."""
    return r[5] > 0 or not (r[1] == r[2] == r[3] == r[4])


def weekend(t):
    """Friday 17:00 to Sunday 17:00 New York, when the indices are shut (Dukascopy's
    2012-13 index feed has a few stray candles there)."""
    ny = dt.datetime.fromtimestamp(t - (4 if ny_dst(t) else 5) * 3600, dt.timezone.utc)
    wd = ny.weekday()
    return wd == 5 or (wd == 4 and ny.hour >= 17) or (wd == 6 and ny.hour < 17)


def read_dukascopy(sym):
    """All 1-minute candles of a DUKA_ONLY symbol: the month files, then recent.json."""
    scale = SYMBOLS[sym][1]
    rows = {}
    folder = os.path.join(RAW, sym)
    for name in sorted(os.listdir(folder)):
        if name.startswith("duka-"):
            for r in json.load(open(os.path.join(folder, name))):
                if real(r):
                    rows[r[0] // 1000] = r[1:5]
    for ts, op, hi, lo, cl, _ in read_recent(sym):
        rows[ts] = (op, hi, lo, cl)
    t, o, h, l, c, v = new_bars()
    index = SYMBOLS[sym][0] == "Indices"
    for ts in sorted(rows):
        if index and weekend(ts):
            continue
        r = rows[ts]
        t.append(ts); o.append(round(r[0] * scale)); h.append(round(r[1] * scale)); l.append(round(r[2] * scale)); c.append(round(r[3] * scale)); v.append(0)
    return t, o, h, l, c, v


def read_recent(sym):
    """(time, open, high, low, close, volume) rows from recent.json, without the
    flat filler candles Dukascopy sends while the market is closed."""
    path = os.path.join(RAW, sym, "recent.json")
    if not os.path.exists(path):
        return []
    return [(r[0] // 1000, *r[1:6]) for r in json.load(open(path)) if real(r)]


def read_binance():
    t, o, h, l, c, v = new_bars()
    folder = os.path.join(RAW, "BTCUSD")
    rows = {}
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".zip"):
            continue
        with zipfile.ZipFile(os.path.join(folder, name)) as z:
            for member in z.namelist():
                for r in csv.reader(io.TextIOWrapper(z.open(member))):
                    if not r[0].isdigit():
                        continue
                    ts = int(r[0])
                    ts //= 1_000_000 if ts > 10**14 else 1000  # Binance switched to microseconds in 2025
                    rows[ts] = r
    for ts, op, hi, lo, cl, vol in read_recent("BTCUSD"):
        rows.setdefault(ts, [ts, op, hi, lo, cl, vol])
    for ts in sorted(rows):
        r = rows[ts]
        t.append(ts)
        o.append(round(float(r[1]) * 100)); h.append(round(float(r[2]) * 100))
        l.append(round(float(r[3]) * 100)); c.append(round(float(r[4]) * 100))
        v.append(float(r[5]))
    return t, o, h, l, c, v


# ---------------------------------------------------------------- aggregate

def ny_dst(t):
    """True when New York is on summer time (2nd Sunday of March -> 1st Sunday of November)."""
    d = dt.datetime.fromtimestamp(t, dt.timezone.utc)
    y = d.year
    mar = dt.datetime(y, 3, 8, 7, tzinfo=dt.timezone.utc)      # 2am EST = 7:00 UTC
    nov = dt.datetime(y, 11, 1, 6, tzinfo=dt.timezone.utc)     # 2am EDT = 6:00 UTC
    mar += dt.timedelta((6 - mar.weekday()) % 7)
    nov += dt.timedelta((6 - nov.weekday()) % 7)
    return mar <= d < nov


def shift(sym, t):
    """Forex days run from 17:00 New York to 17:00 New York (broker GMT+2/+3 time).
    BTC days run on UTC."""
    if sym == "BTCUSD":
        return 0
    return 3 * 3600 if ny_dst(t) else 2 * 3600


def bucket(sym, tf, t):
    """Open time (real UTC) of the `tf` candle that contains time t."""
    size = TFS[tf][0]
    if tf in ("M1", "M5", "M15", "M30", "H1"):
        return t - t % size
    off = shift(sym, t)
    s = t + off
    if tf in ("H4", "D1"):
        s -= s % size
    elif tf == "W1":
        s -= s % 86400
        s -= dt.datetime.fromtimestamp(s, dt.timezone.utc).weekday() * 86400  # Monday
    else:  # MN
        d = dt.datetime.fromtimestamp(s, dt.timezone.utc)
        s = int(dt.datetime(d.year, d.month, 1, tzinfo=dt.timezone.utc).timestamp())
    return s - off


def aggregate(sym, tf, src):
    t, o, h, l, c, v = src
    out = new_bars()
    T, O, H, L, C, V = out
    size = TFS[tf][0]
    fixed = tf in ("M5", "M15", "M30", "H1")
    cur = None
    hour_cache = {}  # for H4 and up, bucket() only depends on the hour
    for i in range(len(t)):
        if fixed:
            b = t[i] - t[i] % size
        else:
            hr = t[i] - t[i] % 3600
            b = hour_cache.get(hr)
            if b is None:
                b = hour_cache[hr] = bucket(sym, tf, hr)
        if b != cur:
            cur = b
            T.append(b); O.append(o[i]); H.append(h[i]); L.append(l[i]); C.append(c[i]); V.append(v[i])
        else:
            if h[i] > H[-1]: H[-1] = h[i]
            if l[i] < L[-1]: L[-1] = l[i]
            C[-1] = c[i]; V[-1] += v[i]
    return out


def chunk_key(period, t):
    d = dt.datetime.fromtimestamp(t, dt.timezone.utc)
    if period == "month":
        return f"{d.year}-{d.month:02d}"
    if period == "quarter":
        return f"{d.year}-Q{(d.month - 1) // 3 + 1}"
    if period == "year":
        return str(d.year)
    return "all"


def write_tf(out, sym, tf, bars):
    t, o, h, l, c, v = bars
    folder = os.path.join(out, sym, tf)
    os.makedirs(folder, exist_ok=True)
    chunks = []
    i = 0
    while i < len(t):
        key = chunk_key(TFS[tf][1], t[i])
        j = i
        while j < len(t) and chunk_key(TFS[tf][1], t[j]) == key:
            j += 1
        buf = bytearray(24 * (j - i))
        for n, k in enumerate(range(i, j)):
            struct.pack_into("<5if", buf, n * 24, t[k], o[k], h[k], l[k], c[k], v[k])
        save(os.path.join(folder, f"{key}.bin"), bytes(buf))
        chunks.append({"key": key, "from": t[i], "to": t[j - 1], "n": j - i})
        i = j
    return chunks


def build():
    index = {"generated": int(time.time()), "timeframes": list(TFS), "symbols": []}
    # Build next to the output, swap at the end so the app never sees half a build.
    tmp = os.path.join(ROOT, "_work", "prices", "market.new")
    shutil.rmtree(tmp, ignore_errors=True)
    # Symbols not named on the command line keep their current build.
    old_index = {}
    if ONLY and os.path.exists(os.path.join(OUT, "index.json")):
        old_index = {e["name"]: e for e in json.load(open(os.path.join(OUT, "index.json")))["symbols"]}
    for sym, (group, scale, digits) in SYMBOLS.items():
        if ONLY and sym not in ONLY:
            if sym in old_index:
                shutil.copytree(os.path.join(OUT, sym), os.path.join(tmp, sym), copy_function=os.link)  # hard links: instant
                index["symbols"].append(old_index[sym])
            continue
        if not os.path.isdir(os.path.join(RAW, sym)):
            print(f"   {sym}: no data, skipped")
            continue
        t0 = time.time()
        bars = read_binance() if sym == "BTCUSD" else read_dukascopy(sym) if sym in DUKA_ONLY else read_histdata(sym)
        if not bars[0]:
            continue
        entry = {"name": sym, "group": group, "scale": scale, "digits": digits, "tfs": {}}
        # each timeframe is built from the one before it (all bucket edges line up)
        chain = [("M1", None), ("M5", "M1"), ("M15", "M5"), ("M30", "M15"), ("H1", "M30"),
                 ("H4", "H1"), ("D1", "H1"), ("W1", "D1"), ("MN", "D1")]
        built = {}
        for tf, base in chain:
            built[tf] = bars if base is None else aggregate(sym, tf, built[base])
            entry["tfs"][tf] = write_tf(tmp, sym, tf, built[tf])
        index["symbols"].append(entry)
        print(f"   {sym}: {len(bars[0]):,} M1 candles ({time.time() - t0:.0f}s)", flush=True)
    save(os.path.join(tmp, "index.json"), json.dumps(index, separators=(",", ":")).encode())
    old = os.path.join(ROOT, "_work", "prices", "market.old")
    shutil.rmtree(old, ignore_errors=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.replace(OUT, old)
    os.replace(tmp, OUT)
    shutil.rmtree(old, ignore_errors=True)
    print(f"==> built {OUT}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    ONLY.update(sys.argv[2:])
    if ONLY - set(SYMBOLS):
        sys.exit(f"unknown symbols: {' '.join(sorted(ONLY - set(SYMBOLS)))}")
    if cmd in ("fetch", "all"):
        fetch()
    if cmd in ("build", "all"):
        print("==> Building timeframes")
        build()
