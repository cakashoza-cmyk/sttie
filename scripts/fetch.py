"""STTIE data refresh. Free public sources only, no keys. Writes data/live.json.
Each source is fetched independently; on failure the last good value is kept and marked stale."""
import json, re, ssl, html, io, sys, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "live.json"
IST = timezone(timedelta(hours=5, minutes=30))
CA = ROOT / "certs" / "letsencrypt_yr1_chain.pem"
UA = {"User-Agent": "Mozilla/5.0 (STTIE data refresh; github.com/cakashoza-cmyk/sttie)"}
NOW = datetime.now(IST)


def get(url, headers=None, timeout=45, extra_ca=False):
    ctx = ssl.create_default_context()
    if extra_ca and CA.exists():
        ctx.load_verify_locations(str(CA))
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return r.read()


def check(v, lo, hi, name):
    if v is None or not (lo <= v <= hi):
        raise ValueError(f"{name}={v} outside sanity range {lo}-{hi}")
    return v


# ---------- sources ----------
def brent():
    url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU"
    rows = [l.split(",") for l in get(url).decode().strip().splitlines()[1:]]
    hist = [[d, float(v)] for d, v in rows if v not in (".", "")][-1000:]
    d, v = hist[-1]
    return dict(label="Brent crude (spot)", value=check(v, 15, 250, "brent"), unit="US$/barrel", as_of=d,
                source="US EIA via FRED (series DCOILBRENTEU)", source_url="https://fred.stlouisfed.org/series/DCOILBRENTEU",
                status="live", note="Daily spot price, published with a 1-3 day lag.", history=hist)


def rbi():
    t = get("https://www.rbi.org.in/", timeout=60).decode("utf-8", "ignore")
    t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t)))
    repo = float(re.search(r"Policy Repo Rate\s*:\s*([\d.]+)\s*%", t).group(1))
    usd = float(re.search(r"INR\s*/\s*1 USD\s*:\s*([\d.]+)", t).group(1))
    m = re.search(r"\(As at [^)]*? of (\w+ \d{1,2}, \d{4})\)", t)
    fx_date = datetime.strptime(m.group(1), "%B %d, %Y").strftime("%Y-%m-%d") if m else NOW.strftime("%Y-%m-%d")
    return {
        "repo": dict(label="RBI policy repo rate", value=check(repo, 2, 12, "repo"), unit="% p.a.", as_of=NOW.strftime("%Y-%m-%d"),
                     source="Reserve Bank of India homepage, 'Current Rates'", source_url="https://www.rbi.org.in/",
                     status="official", note="Date shown is the date we read it from the RBI site."),
        "usdinr": dict(label="USD/INR reference rate", value=check(usd, 60, 140, "usdinr"), unit="₹ per US$", as_of=fx_date,
                       source="FBIL reference rate, as shown on RBI homepage", source_url="https://www.fbil.org.in/",
                       status="official", note="Set once a day around 1:30 pm IST. Customs uses its own notified rate (CBIC), which can differ slightly."),
    }


def ecb():
    start = (NOW - timedelta(days=1500)).strftime("%Y-%m-%d")
    j = json.loads(get(f"https://api.frankfurter.dev/v1/{start}..?base=USD&symbols=INR,CNY"))
    days = sorted(j["rates"])
    inr = [[d, j["rates"][d]["INR"]] for d in days]
    cny = [[d, j["rates"][d]["CNY"]] for d in days]
    common = dict(source="European Central Bank reference rates via Frankfurter API", source_url="https://www.frankfurter.app/", status="live")
    return {
        "usdinr_ecb": dict(label="USD/INR (ECB cross rate)", value=check(inr[-1][1], 60, 140, "inr"), unit="₹ per US$", as_of=inr[-1][0],
                           note="Used for history/trend charts; FBIL rate is used for today's calculations.", history=inr, **common),
        "usdcny": dict(label="USD/CNY", value=check(cny[-1][1], 5, 9, "cny"), unit="CNY per US$", as_of=cny[-1][0],
                       note="Used to convert China futures prices into rupees.", history=cny, **common),
    }


SINA = {"pta": ("TA0", "China PTA futures (Zhengzhou, main contract)", 2000, 15000),
        "meg": ("EG0", "China MEG futures (Dalian, main contract)", 2000, 15000),
        "psf": ("PF0", "China polyester staple fibre futures (Zhengzhou)", 3000, 20000),
        "px": ("PX0", "China paraxylene futures (Zhengzhou)", 3000, 20000)}


def sina(key):
    sym, label, lo, hi = SINA[key]
    ref = {"Referer": "https://finance.sina.com.cn/"}
    raw = get(f"https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_x=/InnerFuturesNewService.getDailyKLine?symbol={sym}", ref).decode()
    arr = json.loads(raw[raw.index("(") + 1: raw.rindex(")")])
    hist = [[r["d"], float(r["c"])] for r in arr][-1000:]
    d, v = hist[-1]
    try:  # intraday / today's latest
        q = get(f"https://hq.sinajs.cn/list=nf_{sym}", ref).decode("gbk", "ignore")
        f = q.split('"')[1].split(",")
        last, qd = float(f[8]), f[17]
        if last > 0 and re.fullmatch(r"\d{4}-\d{2}-\d{2}", qd) and qd >= d:
            v, d = last, qd
            if hist[-1][0] == qd:
                hist[-1][1] = last
            else:
                hist.append([qd, last])
    except Exception:
        pass
    return dict(label=label, value=check(v, lo, hi, key), unit="CNY per tonne", as_of=d,
                source="Exchange futures price via Sina Finance public quote feed", source_url=f"https://finance.sina.com.cn/futures/quotes/{sym}.shtml",
                status="live", note="China domestic price, includes 13% China VAT. Continuous main contract, so the line can jump when the contract rolls.", history=hist)


WPI_ITEMS = {"wpi_pta": "1310010007", "wpi_meg": "1310010004", "wpi_pet": "1310030002", "wpi_mmf": "1310080000",
             "wpi_poly_yarn": "1310080001", "wpi_psf": "1310080003", "wpi_poly_fabric": "1304070001",
             "wpi_synth_woven": "1304020005", "wpi_all": "1000000000"}


def wpi():
    import openpyxl
    page = get("https://eaindustry.nic.in/download_data_2223.asp", extra_ca=True).decode("utf-8", "ignore")
    path = re.search(r"indx_download_2223/wpi_monthly_index_\d{6}\.xlsx", page).group(0)
    url = "https://eaindustry.nic.in/" + path
    wb = openpyxl.load_workbook(io.BytesIO(get(url, extra_ca=True, timeout=90)), read_only=True)
    rows = list(wb.worksheets[0].iter_rows(values_only=True))
    hdr = rows[0]
    mcols = [(i, datetime.strptime(h, "%b-%y").strftime("%Y-%m")) for i, h in enumerate(hdr) if isinstance(h, str) and re.fullmatch(r"[A-Z][a-z]{2}-\d\d", h)]
    by = {str(r[2]): r for r in rows[1:] if r and r[2]}
    out = {}
    for k, code in WPI_ITEMS.items():
        r = by[code]
        hist = [[m, float(r[i])] for i, m in mcols if isinstance(r[i], (int, float))]
        out[k] = dict(label=f"WPI: {r[1].strip().lstrip('abcdefghij.').strip()}", value=check(hist[-1][1], 30, 400, k), unit="index (2022-23 = 100)",
                      as_of=hist[-1][0], source="Office of the Economic Adviser (DPIIT), WPI monthly item index", source_url=url,
                      status="official", note="Official monthly wholesale price index; latest month is provisional. Released ~14th of the next month.", history=hist)
    return out


def headlines():
    q = "(polyester OR POY OR PTA OR MEG OR PSF OR \"filament yarn\") prices India when:45d"
    url = "https://news.google.com/rss/search?q=" + urllib.parse.quote(q) + "&hl=en-IN&gl=IN&ceid=IN:en"
    root = ET.fromstring(get(url))
    items = []
    for it in root.iter("item"):
        t = it.findtext("title") or ""
        if not (re.search(r"\b(POY|PTA|MEG|PSF|PTY|FDY|DTY)\b", t) or re.search(r"polyester|filament", t, re.I)) or not re.search(r"pric", t, re.I):
            continue
        if any(x["title"] == t.lstrip("| ").strip() for x in items):
            continue
        d = datetime.strptime(it.findtext("pubDate"), "%a, %d %b %Y %H:%M:%S %Z").replace(tzinfo=timezone.utc).astimezone(IST)
        items.append({"title": t.lstrip("| ").strip(), "date": d.strftime("%Y-%m-%d"), "url": it.findtext("link")})
    items.sort(key=lambda x: x["date"], reverse=True)
    return items[:12]


import urllib.parse  # noqa: E402


def main():
    prev = json.loads(OUT.read_text()) if OUT.exists() else {"items": {}}
    items, errors = {}, {}

    def run(name, fn, keys=None):
        try:
            r = fn()
            if keys is None:
                items.update(r)
            else:
                items[keys] = r
        except Exception as e:  # noqa: BLE001
            errors[name] = f"{type(e).__name__}: {e}"[:300]
            for k in ([keys] if keys else [k for k in prev["items"] if prev["items"][k].get("group") == name]):
                if k in prev["items"]:
                    old = dict(prev["items"][k]); old["status"] = "stale"; old["stale_reason"] = errors[name]
                    items[k] = old

    run("fred", brent, "brent")
    run("rbi", rbi)
    run("ecb", ecb)
    for k in SINA:
        run("sina_" + k, lambda k=k: sina(k), k)
    run("wpi", wpi)
    groups = {"brent": "fred", "repo": "rbi", "usdinr": "rbi", "usdinr_ecb": "ecb", "usdcny": "ecb", **{k: "sina_" + k for k in SINA}, **{k: "wpi" for k in WPI_ITEMS}}
    for k, v in items.items():
        v["group"] = groups.get(k, "")
    try:
        news = headlines()
    except Exception as e:  # noqa: BLE001
        errors["news"] = str(e)[:300]; news = prev.get("headlines", [])
    out = {"generated_ist": NOW.strftime("%Y-%m-%d %H:%M IST"), "items": items, "errors": errors, "headlines": news,
           "headlines_source": "Google News RSS search (public). Headlines only; not used in any calculation."}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print("items:", len(items), "| errors:", json.dumps(errors))
    for k, v in items.items():
        print(f"  {k:16s} {v['value']:>10} {v['unit']:22s} as of {v['as_of']}  [{v['status']}]")
    if len(items) < 5:
        sys.exit(2)


if __name__ == "__main__":
    main()
