"""STTIE prediction ledger, scoring and learning. Numbers only from data/live.json (public sources).
No AI is used anywhere here; every number is plain arithmetic or least squares, written to JSON.

Target: China-cost-based POY estimate in Rs/kg, ex-VAT, ex-GST
  PET cost  = (0.865*PTA + 0.335*MEG) / 1.13 * (INR per CNY) / 1000
  spread    = median over last 60 trading days of (PSF/1.13*INRperCNY/1000 - PET cost)   [China market spread, proxy]
  POY est.  = PET cost + spread
Forecast of PET % change over h days (h = 7, 30):
  dPET% = w_mom * (PET % change over last h days)
        + w_brent * (Brent % change over the h days ending L days ago)
        + w_fx * (INR-per-CNY % change over last h days)
  weights re-fitted every run by ridge least squares on realised history (heavy shrinkage toward 'no change');
  Brent lag L re-chosen every run from {0,3,7,14,21} days by best fit on realised history.
"""
import json, bisect, statistics as st
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
LIVE, PRED, MODEL = ROOT / "data/live.json", ROOT / "data/predictions.json", ROOT / "data/model.json"
IST = timezone(timedelta(hours=5, minutes=30))
VERSION_BASE = "v1"
A_PTA, B_MEG, VAT = 0.865, 0.335, 1.13
BAND = {7: 1.0, 30: 2.0}           # % move treated as 'flat'
LAGS = [0, 3, 7, 14, 21]
CC_SPREAD = 4.0                    # assumption: MSME cash-credit rate = repo + 4.0%
RIDGE = 0.5                        # shrinkage strength (x number of samples)


def D(s):
    return date.fromisoformat(s[:10])


class Series:
    def __init__(self, hist):
        self.d = [D(a) for a, _ in hist]; self.v = [b for _, b in hist]

    def at(self, day):  # last value on or before day
        i = bisect.bisect_right(self.d, day) - 1
        return self.v[i] if i >= 0 else None

    def on_or_after(self, day):
        i = bisect.bisect_left(self.d, day)
        return (self.d[i], self.v[i]) if i < len(self.d) else (None, None)


def build(live):
    it = live["items"]
    S = {k: Series(it[k]["history"]) for k in ("pta", "meg", "psf", "brent", "usdinr_ecb", "usdcny")}
    days = S["pta"].d
    rows = {}
    for d in days:
        pta, meg, psf, inr, cny, br = (S[k].at(d) for k in ("pta", "meg", "psf", "usdinr_ecb", "usdcny", "brent"))
        if None in (pta, meg, inr, cny, br):
            continue
        rc = inr / cny
        pet = (A_PTA * pta + B_MEG * meg) / VAT * rc / 1000
        psf_r = psf / VAT * rc / 1000 if psf else None
        rows[d] = dict(pet=pet, psf=psf_r, rc=rc, brent=br, pta=pta, meg=meg, inr=inr, cny=cny)
    ds = sorted(rows)
    for i, d in enumerate(ds):
        win = [rows[x]["psf"] - rows[x]["pet"] for x in ds[max(0, i - 59): i + 1] if rows[x]["psf"]]
        rows[d]["spread"] = st.median(win) if win else None
        rows[d]["poy"] = rows[d]["pet"] + rows[d]["spread"] if rows[d]["spread"] is not None else None
    return rows, ds


def val(rows, ds, day, key):
    i = bisect.bisect_right(ds, day) - 1
    return rows[ds[i]][key] if i >= 0 else None


def features(rows, ds, d, h, lag):
    p0, p1 = val(rows, ds, d - timedelta(days=h), "pet"), rows[d]["pet"]
    b0, b1 = val(rows, ds, d - timedelta(days=h + lag), "brent"), val(rows, ds, d - timedelta(days=lag), "brent")
    f0, f1 = val(rows, ds, d - timedelta(days=h), "rc"), rows[d]["rc"]
    if None in (p0, b0, b1, f0):
        return None
    return [100 * (p1 / p0 - 1), 100 * (b1 / b0 - 1), 100 * (f1 / f0 - 1)]


def realised(rows, ds, d, h):
    i = bisect.bisect_left(ds, d + timedelta(days=h))
    if i >= len(ds):
        return None, None
    return ds[i], rows[ds[i]]


def samples(rows, ds, h, lag, before=None):
    X, y = [], []
    for d in ds:
        r_d, r = realised(rows, ds, d, h)
        if r is None or (before and r_d >= before):
            continue
        f = features(rows, ds, d, h, lag)
        if f:
            X.append(f); y.append(100 * (r["pet"] / rows[d]["pet"] - 1))
    return np.array(X), np.array(y)


VARS = ["momentum", "brent", "fx"]


def ridge(X, y, mask=(1, 1, 1)):
    m = np.array(mask, dtype=float)
    if len(y) < 30 or not m.any():
        return np.zeros(3)
    Xm = X * m
    lam = RIDGE * len(y)
    return np.linalg.solve(Xm.T @ Xm + lam * np.eye(3), Xm.T @ y) * m


def fit(rows, ds, h, before=None, mask=(1, 1, 1)):
    best = None
    for lag in (LAGS if mask[1] else [0]):
        X, y = samples(rows, ds, h, lag, before)
        if len(y) < 30:
            continue
        w = ridge(X, y, mask)
        sse = float(((y - X @ w) ** 2).mean())
        if best is None or sse < best[2]:
            best = (lag, w, sse, len(y))
    return best  # (lag, weights, mse, n)


DUTY_MULT = 1 + 0.05 + 0.05 * 0.10   # BCD 5% + SWS 10% of BCD (IGST is recoverable, so left out of economic cost)


def import_gap(live, rows, ds):
    """Monthly: Indian WPI 'Synthetic polyester yarn' vs China-landed POY estimate, both rebased to their
    average over the first 12 months they overlap. gap > 0: Indian yarn is dearer than usual vs imports."""
    wpi = dict(live["items"]["wpi_poly_yarn"]["history"])
    mon = {}
    for d in ds:
        if rows[d]["poy"]:
            mon.setdefault(d.strftime("%Y-%m"), []).append(rows[d]["poy"] * DUTY_MULT)
    cur = ds[-1].strftime("%Y-%m")
    months = [m for m in sorted(mon) if m in wpi and m != cur]
    if len(months) < 14:
        return None
    base = months[:12]
    bw = st.mean(wpi[m] for m in base); bl = st.mean(st.mean(mon[m]) for m in base)
    series = [[m, round(100 * ((wpi[m] / bw) / (st.mean(mon[m]) / bl) - 1), 2)] for m in months]
    return dict(base_months=f"{base[0]} to {base[-1]}", series=series, latest_month=series[-1][0], latest_gap_pct=series[-1][1])


def gap_call(g):
    return "imports look cheaper than usual" if g > 3 else "imports look dearer than usual" if g < -3 else "normal gap"


def direction(pct, h):
    return "up" if pct > BAND[h] else "down" if pct < -BAND[h] else "flat"


def backtest(rows, ds, h, step=5, warm=250, mask=(1, 1, 1)):
    out = []
    for i in range(warm, len(ds), step):
        d = ds[i]
        f = fit(rows, ds, h, before=d, mask=mask)
        if not f:
            continue
        lag, w, _, _ = f
        x = features(rows, ds, d, h, lag); r_d, r = realised(rows, ds, d, h)
        if not x or r is None:
            continue
        pred = float(np.dot(w, x)); act = 100 * (r["pet"] / rows[d]["pet"] - 1)
        out.append(dict(d=d.isoformat(), pred=pred, act=act, err_rs=(pred - act) / 100 * rows[d]["pet"], base=rows[d]["pet"]))
    if not out:
        return None
    hit = [direction(o["pred"], h) == direction(o["act"], h) for o in out]
    naive = [direction(0, h) == direction(o["act"], h) for o in out]
    mae = st.mean(abs(o["err_rs"]) for o in out)
    mae_naive = st.mean(abs(o["act"] / 100 * o["base"]) for o in out)
    return dict(n=len(out), start=out[0]["d"], end=out[-1]["d"], hit_rate=round(100 * sum(hit) / len(hit), 1),
                naive_hit_rate=round(100 * sum(naive) / len(naive), 1), mae_rs=round(mae, 2), naive_mae_rs=round(mae_naive, 2),
                err_band_rs=round(float(np.percentile([abs(o["err_rs"]) for o in out], 80)), 2))


RULE1 = dict(days=7, pass_pct=100, band_pct=1.0)  # trader rule of thumb: mills pass PTA/MEG cost changes into POY within ~7 days


def rule1_call(rows, ds, d, r=RULE1):
    p0 = val(rows, ds, d - timedelta(days=r["days"]), "pet")
    if p0 is None or rows[d]["poy"] is None:
        return None, None
    exp = (rows[d]["pet"] - p0) * r["pass_pct"] / 100
    band = rows[d]["poy"] * r["band_pct"] / 100
    return ("buy now" if exp > band else "wait" if exp < -band else "buy small"), exp


def rule1_hit(call, move, base, r=RULE1):
    band = base * r["band_pct"] / 100
    return move > 0 if call == "buy now" else move < 0 if call == "wait" else abs(move) <= band


def rule1_backtest(rows, ds, start=250):
    res = []
    for d in ds[start:]:
        c, exp = rule1_call(rows, ds, d)
        r_d, r = realised(rows, ds, d, RULE1["days"])
        if c is None or r is None or r["poy"] is None:
            continue
        res.append((c, rule1_hit(c, r["poy"] - rows[d]["poy"], rows[d]["poy"])))
    by = {}
    for c, h in res:
        by.setdefault(c, []).append(h)
    return dict(n=len(res), start=ds[start].isoformat(), hit_rate=round(100 * sum(h for _, h in res) / len(res), 1) if res else None,
                by_call={c: dict(n=len(v), hit_rate=round(100 * sum(v) / len(v), 1)) for c, v in by.items()},
                note="Back-test on China futures data (PSF-based POY estimate as the 'price'), not on Indian mill quotes.")


def main():
    live = json.loads(LIVE.read_text())
    now = datetime.now(IST); today = now.date()
    rows, ds = build(live)
    last = ds[-1]
    model = json.loads(MODEL.read_text()) if MODEL.exists() else {"changelog": []}
    ledger = json.loads(PRED.read_text()) if PRED.exists() else {"predictions": []}
    repo = live["items"].get("repo", {}).get("value")

    # ---- 1. learn: a variable keeps weight only if it lowered out-of-sample error in the walk-forward test ----
    new, bt, gates = {}, {}, {}
    for h in (7, 30):
        naive = backtest(rows, ds, h, mask=(0, 0, 0))["naive_mae_rs"]
        mask, why = [1, 1, 1], {}
        full = backtest(rows, ds, h, mask=tuple(mask))["mae_rs"]
        for j, v in enumerate(VARS):
            trial = list(mask); trial[j] = 0
            without = backtest(rows, ds, h, mask=tuple(trial))["mae_rs"] if any(trial) else naive
            if not (full <= without * 0.99):  # a variable must cut out-of-sample error by at least 1% to keep weight
                mask = trial
                why[v] = f"weight set to 0: out-of-sample error was Rs {full}/kg with it and Rs {without}/kg without it, so it did not cut error by at least 1%"
                full = without
            else:
                why[v] = f"earned weight: out-of-sample error Rs {full}/kg with it vs Rs {without}/kg without it"
        if any(mask) and not (full <= naive * 0.99):
            for j, v in enumerate(VARS):
                if mask[j]:
                    why[v] += f"; but the combined model (Rs {full}/kg) still did not beat 'assume no change' (Rs {naive}/kg), so weight set to 0"
            mask = [0, 0, 0]
        gates[str(h)] = dict(mask=mask, why=why)
        bt[str(h)] = backtest(rows, ds, h, mask=tuple(mask))
        if not any(mask):
            bt[str(h)]["mae_rs"] = bt[str(h)]["naive_mae_rs"]; bt[str(h)]["hit_rate"] = bt[str(h)]["naive_hit_rate"]
        f = fit(rows, ds, h, mask=tuple(mask)) if any(mask) else (0, np.zeros(3), 0.0, 0)
        lag, w, mse, n = f
        new[str(h)] = dict(lag_days=lag, gate=gates[str(h)],  w_momentum=round(float(w[0]), 4), w_brent=round(float(w[1]), 4), w_fx=round(float(w[2]), 4),
                           train_n=n, train_rmse_pct=round(mse ** 0.5, 2), train_first=ds[0].isoformat(), train_last=last.isoformat())
    old = model.get("horizons", {})
    changes = []
    for h, nh in new.items():
        oh = old.get(h)
        if not oh and not any(nh["gate"]["mask"]):
            changes.append(f"{h}-day model first fitted: no variable (momentum, Brent, FX) beat 'assume no change' out of sample, so all weights are 0 and the forecast is 'no change'.")
            continue
        if not oh:
            changes.append(f"{h}-day model first fitted on {nh['train_n']} realised outcomes: momentum weight {nh['w_momentum']}, Brent weight {nh['w_brent']} (lag {nh['lag_days']} days), FX weight {nh['w_fx']}.")
            continue
        for k, label in (("w_momentum", "momentum weight"), ("w_brent", "Brent weight"), ("w_fx", "FX weight")):
            if abs(nh[k] - oh[k]) >= 0.02:
                changes.append(f"{h}-day {label} {oh[k]} -> {nh[k]} after re-fitting on {nh['train_n']} realised outcomes (data to {nh['train_last']}).")
        if oh.get("gate") and oh["gate"]["mask"] != nh["gate"]["mask"]:
            for j, v in enumerate(VARS):
                if oh["gate"]["mask"][j] != nh["gate"]["mask"][j]:
                    changes.append(f"{h}-day {v}: " + ("earned weight" if nh["gate"]["mask"][j] else "lost its weight") + f" ({nh['gate']['why'][v]}).")
        if nh["lag_days"] != oh["lag_days"]:
            changes.append(f"{h}-day Brent lag {oh['lag_days']} -> {nh['lag_days']} days: the new lag fits realised PTA/MEG moves better.")
    spread = rows[last]["spread"]
    if model.get("spread_rs") is not None and abs(spread - model["spread_rs"]) >= 0.5:
        changes.append(f"Conversion spread (China PSF minus PET cost, 60-day median) {model['spread_rs']:.2f} -> {spread:.2f} Rs/kg, from realised China prices.")

    # ---- 2. score matured live predictions ----
    scored_now = []
    for p in ledger["predictions"]:
        if p.get("scored"):
            continue
        r_d, r = realised(rows, ds, D(p["made_on"]), p["horizon_days"])
        if r is None:
            continue
        if p.get("kind") == "rule1":
            mv = r["poy"] - p["inputs"]["poy_rs"]
            p.update(scored=True, realised_on=r_d.isoformat(), realised_poy_rs=round(r["poy"], 2), realised_move_rs=round(mv, 2),
                     error_rs=round(p["expected_move_rs"] - mv, 2), hit_buy_call=rule1_hit(p["buy_call"], mv, p["inputs"]["poy_rs"]))
            scored_now.append(p)
            continue
        act_pct = 100 * (r["pet"] / p["inputs"]["pet_rs"] - 1)
        act_poy = r["poy"]
        err = p["pred_poy_rs"] - act_poy
        hit_dir = direction(act_pct, p["horizon_days"]) == p["direction"]
        carry = p["inputs"]["carry_rs"]
        if p["buy_call"] == "buy now":
            hit_buy = act_poy - p["inputs"]["poy_rs"] > carry
        elif p["buy_call"] == "wait":
            hit_buy = act_poy - p["inputs"]["poy_rs"] < 0
        else:
            hit_buy = abs(act_poy - p["inputs"]["poy_rs"]) <= carry + p["inputs"]["poy_rs"] * BAND[p["horizon_days"]] / 100
        hit_imp = None
        if p.get("import_call") and p["horizon_days"] == 30:
            g = import_gap(live, rows, ds)
            later = [v for m, v in (g["series"] if g else []) if m > p["inputs"].get("gap_month", "9999")]
            if not later:
                continue  # wait for the next official WPI month
            hit_imp = gap_call(later[0]) == p["import_call"]
        p.update(scored=True, realised_on=r_d.isoformat(), realised_poy_rs=round(act_poy, 2), realised_pct=round(act_pct, 2),
                 error_rs=round(err, 2), hit_direction=hit_dir, hit_buy_call=hit_buy, hit_import=hit_imp,
                 within_band=abs(err) <= p["error_band_rs"])
        scored_now.append(p)

    # ---- 3. error band from backtest + live errors ----
    for h in ("7", "30"):
        live_err = [abs(p["error_rs"]) for p in ledger["predictions"] if p.get("scored") and p["horizon_days"] == int(h)]
        band = float(np.percentile(live_err, 80)) if len(live_err) >= 10 else (bt[h]["err_band_rs"] if bt[h] else None)
        new[h]["error_band_rs"] = round(band, 2) if band else None
        new[h]["error_band_basis"] = "80th percentile of scored live errors" if len(live_err) >= 10 else "80th percentile of back-test errors (too few live results yet)"
        if old.get(h, {}).get("error_band_rs") and band and abs(band - old[h]["error_band_rs"]) >= 0.25:
            changes.append(f"{h}-day error band {old[h]['error_band_rs']} -> {round(band, 2)} Rs/kg ({new[h]['error_band_basis']}).")

    version = f"{VERSION_BASE}.{len(model.get('changelog', [])) + (1 if changes else 0)}"
    if changes:
        model.setdefault("changelog", []).insert(0, {"date": today.isoformat(), "version": version, "changes": changes})
    model["import_gap"] = import_gap(live, rows, ds)
    model.update(version=version, updated_ist=now.strftime("%Y-%m-%d %H:%M IST"), horizons=new, spread_rs=round(spread, 2), backtest=bt,
                 data_last_date=last.isoformat(), formula=__doc__.strip(), band_pct=BAND, cc_spread_assumption_pct=CC_SPREAD)

    # ---- 4. log today's predictions (once per data date) ----
    stale = (today - last).days > 4
    if not stale and not any(p["made_on"] == last.isoformat() for p in ledger["predictions"]):
        r = rows[last]
        rate = (repo or 0) + CC_SPREAD
        duty_mult = DUTY_MULT
        gap = import_gap(live, rows, ds)
        for h in (7, 30):
            m = new[str(h)]
            x = features(rows, ds, last, h, m["lag_days"])
            pct = m["w_momentum"] * x[0] + m["w_brent"] * x[1] + m["w_fx"] * x[2]
            pred_poy = r["poy"] * 1 + r["pet"] * pct / 100
            carry = r["poy"] * rate / 100 * h / 365
            move = pred_poy - r["poy"]
            edge = bool(bt[str(h)] and any(m["gate"]["mask"]) and bt[str(h)]["mae_rs"] < bt[str(h)]["naive_mae_rs"])
            buy = "buy now" if move > carry + m["error_band_rs"] * 0.5 else "wait" if move < -m["error_band_rs"] * 0.5 else "buy as needed"
            raw_buy = buy
            if not edge:
                buy = "buy as needed"  # model has not beaten 'no change' in the back-test, so it does not make a strong call
            ledger["predictions"].append(dict(
                id=f"{last.isoformat()}-{h}d", made_on=last.isoformat(), logged_ist=now.strftime("%Y-%m-%d %H:%M IST"), horizon_days=h,
                target_date=(last + timedelta(days=h)).isoformat(), model_version=version,
                pred_pct=round(pct, 2), direction=direction(pct, h), pred_poy_rs=round(pred_poy, 2), error_band_rs=m["error_band_rs"],
                buy_call=buy, raw_buy_call=raw_buy, model_has_edge=edge,
                import_call=(gap_call(gap["latest_gap_pct"]) if gap and h == 30 else None),
                inputs=dict(pta_cny=r["pta"], meg_cny=r["meg"], brent=r["brent"], usdinr=r["inr"], usdcny=r["cny"], inr_per_cny=round(r["rc"], 4),
                            pet_rs=round(r["pet"], 2), spread_rs=round(r["spread"], 2), poy_rs=round(r["poy"], 2), features_pct=[round(v, 2) for v in x],
                            weights=[m["w_momentum"], m["w_brent"], m["w_fx"]], brent_lag_days=m["lag_days"], repo_pct=repo,
                            cc_rate_pct=rate, carry_rs=round(carry, 2), duty_mult=duty_mult, import_rs=round(r["poy"] * duty_mult, 2),
                            gap_month=gap and gap["latest_month"], gap_pct=gap and gap["latest_gap_pct"])))
        c, exp = rule1_call(rows, ds, last)
        if c:
            ledger["predictions"].append(dict(id=f"{last.isoformat()}-rule1", kind="rule1", made_on=last.isoformat(), logged_ist=now.strftime("%Y-%m-%d %H:%M IST"),
                                              horizon_days=RULE1["days"], target_date=(last + timedelta(days=RULE1["days"])).isoformat(), model_version=version,
                                              buy_call=c, expected_move_rs=round(exp, 2), rule=RULE1,
                                              inputs=dict(pet_rs=round(rows[last]["pet"], 2), pet_rs_n_days_ago=round(val(rows, ds, last - timedelta(days=RULE1["days"]), "pet"), 2),
                                                          poy_rs=round(rows[last]["poy"], 2), spread_rs=round(rows[last]["spread"], 2))))
    model["rule1"] = dict(params=RULE1, backtest=rule1_backtest(rows, ds),
                          text="Mills (e.g. Reliance) pass PTA/MEG cost changes into POY within about 7 days, so last week's raw-material move shows where yarn is going next week.")
    # ---- 5. lessons (plain text from the numbers above) ----
    lessons = []
    for h in ("7", "30"):
        m, b = new[h], bt[h]
        if b:
            better = b["mae_rs"] < b["naive_mae_rs"]
            lessons.append(f"{h}-day back-test ({b['start']} to {b['end']}, {b['n']} calls): direction right {b['hit_rate']}% vs {b['naive_hit_rate']}% for 'assume no change'; "
                           f"average error Rs {b['mae_rs']}/kg vs Rs {b['naive_mae_rs']}/kg for 'no change'. " + ("The model beats 'no change'." if better else "The model does NOT beat 'no change' yet, so treat its calls as weak."))
        for v, txt in m["gate"]["why"].items():
            lessons.append(f"{h}-day {v}: {txt}.")
        if not any(m["gate"]["mask"]):
            lessons.append(f"{h}-day: no variable has proven predictive value yet, so the forecast is 'no change' and the app makes no strong buy/wait call.")
            continue
        top = max((("recent momentum", abs(m["w_momentum"])), ("Brent", abs(m["w_brent"])), ("FX", abs(m["w_fx"]))), key=lambda t: t[1])
        lessons.append(f"{h}-day: the biggest driver in the fitted model is {top[0]} (weights: momentum {m['w_momentum']}, Brent {m['w_brent']} at {m['lag_days']}-day lag, FX {m['w_fx']}).")
    g = model.get("import_gap")
    if g:
        ser = g["series"]; pairs = list(zip(ser, ser[1:]))
        ok = sum(gap_call(a[1]) == gap_call(b[1]) for a, b in pairs)
        model["import_gap_backtest"] = dict(n=len(pairs), hit_rate=round(100 * ok / len(pairs), 1) if pairs else None)
        lessons.append(f"Import check back-test: the month-ahead 'import gap' call (it assumes this month's gap persists) held {model['import_gap_backtest']['hit_rate']}% of the time over {len(pairs)} months. Latest gap {g['latest_gap_pct']}% ({g['latest_month']}): {gap_call(g['latest_gap_pct'])}.")
    rb = model["rule1"]["backtest"]
    lessons.append(f"Rule of thumb 1 ('mills follow PTA/MEG within a week') back-test since {rb['start']}: right {rb['hit_rate']}% of {rb['n']} days ({', '.join(f'{k}: {v['hit_rate']}% of {v['n']}' for k, v in rb['by_call'].items())}). On China data, not Indian mill quotes.")
    sc = [p for p in ledger["predictions"] if p.get("scored")]
    if len(sc) < 10:
        lessons.append(f"Live track record: learning, too few results yet ({len(sc)} scored).")
    model["lessons"] = lessons
    ledger["predictions"] = ledger["predictions"][-1500:]
    PRED.write_text(json.dumps(ledger, indent=0))
    # downloadable track record + versioned model archive
    import csv
    cols = ["id", "kind", "made_on", "horizon_days", "target_date", "model_version", "buy_call", "direction", "pred_pct", "pred_poy_rs", "expected_move_rs",
            "error_band_rs", "import_call", "model_has_edge", "scored", "realised_on", "realised_poy_rs", "error_rs", "hit_direction", "hit_buy_call", "hit_import"]
    with open(ROOT / "data/track_record.csv", "w", newline="") as fh:
        w = csv.writer(fh); w.writerow(cols + ["poy_rs_at_call", "pet_rs_at_call"])
        for p in ledger["predictions"]:
            w.writerow([p.get("kind", "model") if c == "kind" else p.get(c, "") for c in cols] + [p["inputs"].get("poy_rs"), p["inputs"].get("pet_rs")])
    arch = ROOT / "data/models"; arch.mkdir(exist_ok=True)
    if not (arch / f"model_{version}.json").exists():
        (arch / f"model_{version}.json").write_text(json.dumps({k: v for k, v in model.items() if k != "import_gap"}, indent=1))
    MODEL.write_text(json.dumps(model, indent=1))
    print("model", version, "| last data", last, "| scored now", len(scored_now), "| changes", len(changes))
    for l in lessons:
        print(" -", l)


if __name__ == "__main__":
    main()
