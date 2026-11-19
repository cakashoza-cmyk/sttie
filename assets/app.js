/* STTIE front end. All numbers come from data/*.json (public sources, fetched by GitHub Actions) or from the user's own entries (localStorage). */
(function () {
"use strict";
const $ = (id) => document.getElementById(id);
const LS = "sttie.v1";
const DEF = { lang: "gu", quote: null, quoteDate: null, ratioPTA: 0.865, ratioMEG: 0.335, removeVat: true, premFDY: 7, premDTY: 19,
  freightRs: 3.0, portRs: 1.2, inlandRs: 1.1, otherRs: 0.75, transitDays: 25, lcRate: 8.5, fcl: 20,
  ccSpread: 4.0, holdDays: 30, storageRs: 0.65, bufferRs: 0.40,
  r1Days: 7, r1Pass: 100, r1Band: 1.0, r4Min: 3.0, r5Cash: 15,
  capital: 20000000, mPOY: 2.0, mFDY: 2.0, mDTY: 2.0, hurdle: 0.5, maxSku: 40,
  simBrent: 0, simPTA: 0, simMEG: 0, simFX: 0, simCredit: 30, simPass: 100, simKg: 20000, log: [] };
let S = Object.assign({}, DEF, JSON.parse(localStorage.getItem(LS) || "{}"));
const save = () => localStorage.setItem(LS, JSON.stringify(S));
let L = null, M = null, P = null, R = null;   // live, model, predictions, rates

const f2 = (x, d = 2) => (x == null || isNaN(x)) ? "—" : Number(x).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, d = 1) => (x == null || isNaN(x)) ? "—" : (x > 0 ? "+" : "") + x.toFixed(d) + "%";
const cls = (x, band = 0.0001) => x > band ? "up" : x < -band ? "down" : "flat";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pill = (k, t) => `<span class="pill p-${k}">${t || k}</span>`;
const fill = (t, o) => t.replace(/\{(\w+)\}/g, (_, k) => o[k] != null ? o[k] : "");

/* ---------- audit trail: every number can show source, time and formula ---------- */
function audit(val, a) {
  const st = a.status || "est";
  const body = [a.source ? `<b>Source:</b> ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.source)}</a>` : esc(a.source)}` : "",
    a.asof ? `<b>As of:</b> ${esc(a.asof)}` : "", a.fetched ? `<b>Fetched:</b> ${esc(a.fetched)}` : "",
    a.formula ? `<b>Formula:</b> <span class="formula" style="display:block">${esc(a.formula)}</span>` : "", a.note ? esc(a.note) : ""].filter(Boolean).join("<br>");
  return `<details class="aud"><summary>${val} ${pill(st === "user" ? "input" : st, st === "user" ? "your input" : st === "est" ? "estimate" : st === "assume" ? "assumption" : st)}</summary><div class="audbox">${body}</div></details>`;
}
function item(k) { return L && L.items[k]; }
function itemAudit(k, valTxt) {
  const it = item(k);
  if (!it) return `<span class="grey">no live source</span> ${pill("none", "no live source")}`;
  return audit(valTxt || f2(it.value), { status: it.status, source: it.source, url: it.source_url, asof: it.as_of, fetched: L.generated_ist,
    note: (it.note || "") + (it.status === "stale" ? " STALE: last refresh failed (" + (it.stale_reason || "") + "); showing last good value." : "") });
}

/* ---------- series & estimates ---------- */
function ser(k) { const it = item(k); return it && it.history ? it.history : []; }
function atOrBefore(h, d) { let lo = 0, hi = h.length - 1, r = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (h[m][0] <= d) { r = h[m][1]; lo = m + 1; } else hi = m - 1; } return r; }
function addDays(d, n) { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function rcToday() { const inr = item("usdinr") || item("usdinr_ecb"), cny = item("usdcny"); return inr && cny ? inr.value / cny.value : null; }
function petFrom(pta, meg, rc) { const v = S.removeVat ? 1.13 : 1; return (S.ratioPTA * pta + S.ratioMEG * meg) / v * rc / 1000; }
function spreadUsed() { const c = calibSpread(); return c ? c.spread : (M ? M.spread_rs : null); }
function est() {
  const pta = item("pta"), meg = item("meg"), rc = rcToday();
  if (!pta || !meg || !rc) return null;
  const pet = petFrom(pta.value, meg.value, rc), sp = spreadUsed();
  if (sp == null) return null;
  const poy = pet + sp;
  return { pet, spread: sp, rc, POY: poy, FDY: poy + Number(S.premFDY), DTY: poy + Number(S.premDTY), ptaRs: pta.value / (S.removeVat ? 1.13 : 1) * rc / 1000, megRs: meg.value / (S.removeVat ? 1.13 : 1) * rc / 1000 };
}
// historical PET series (Rs/kg), ECB INR & CNY history
function petSeries() {
  const pta = ser("pta"), meg = ser("meg"), inr = ser("usdinr_ecb"), cny = ser("usdcny");
  return pta.map(([d, v]) => { const m = atOrBefore(meg, d), i = atOrBefore(inr, d), c = atOrBefore(cny, d); return (m && i && c) ? [d, petFrom(v, m, i / c)] : null; }).filter(Boolean);
}
function changeOver(h, days) { if (h.length < 2) return null; const last = h[h.length - 1]; const prev = atOrBefore(h, addDays(last[0], -days)); return prev ? 100 * (last[1] / prev - 1) : null; }
function absChangeOver(h, days) { if (h.length < 2) return null; const last = h[h.length - 1]; const prev = atOrBefore(h, addDays(last[0], -days)); return prev != null ? last[1] - prev : null; }
function calibSpread() {
  const ps = petSeries(); const rows = (S.log || []).filter((r) => r.sku === "POY" && r.deal > 0);
  if (!rows.length || !ps.length) return null;
  const sp = rows.map((r) => { const p = atOrBefore(ps, r.date); return p ? r.deal - p : null; }).filter((x) => x != null);
  if (!sp.length) return null;
  sp.sort((a, b) => a - b);
  return { spread: sp[Math.floor(sp.length / 2)], n: sp.length };
}
function usedPrice(sku, e) {
  if (sku === "POY" && S.quote > 0) return { v: Number(S.quote), src: "user" };
  return e ? { v: e[sku], src: "est" } : null;
}
function importLanded(e, fxOverride) {
  if (!e || !R) return null;
  const bcd = R.bcd_pct.value / 100, sws = R.sws_pct_of_bcd.value / 100, aidc = R.aidc_pct.value / 100, igst = R.igst_pct.value / 100, add = R.add.value;
  const av = e.POY + Number(S.freightRs) * (fxOverride || 1);
  const B = av * bcd, A = av * aidc, W = (B + A) * sws, base = av + B + A + W + add, I = base * igst;
  const fin = av * Number(S.lcRate) / 100 * Number(S.transitDays) / 365;
  const econ = av + B + A + W + add + Number(S.portRs) + Number(S.inlandRs) + Number(S.otherRs) + fin;
  return { av, B, A, W, add, I, fin, econ, cash: econ + I };
}

/* ---------- today's call (main screen) ---------- */
function latest(kind, h) { if (!P) return null; const xs = P.predictions.filter((p) => (kind === "rule1" ? p.kind === "rule1" : !p.kind && p.horizon_days === h)); return xs[xs.length - 1] || null; }
function todaysCall() {
  const m30 = latest("model", 30), r1 = latest("rule1");
  const ps = petSeries(); const mv = absChangeOver(ps, Number(S.r1Days)); const e = est();
  let call = "buy small", basis = "rule1", exp = mv != null ? mv * S.r1Pass / 100 : null;
  if (m30 && m30.model_has_edge) { call = m30.buy_call === "buy as needed" ? "buy small" : m30.buy_call; basis = "model"; }
  else if (exp != null && e) { const band = e.POY * S.r1Band / 100; call = exp > band ? "buy now" : exp < -band ? "wait" : "buy small"; }
  return { call, basis, exp, mv, m30, r1 };
}
function hitInfo(basis) {
  const sc = (P ? P.predictions : []).filter((p) => p.scored && (basis === "rule1" ? p.kind === "rule1" : !p.kind && p.horizon_days === 30));
  const recent = sc.slice(-20);
  const k = recent.filter((p) => p.hit_buy_call).length;
  const bt = basis === "rule1" ? (M && M.rule1 && M.rule1.backtest.hit_rate) : (M && M.backtest && M.backtest["30"] && M.backtest["30"].hit_rate);
  return { n: recent.length, k, bt: bt != null ? Math.round(bt) : null };
}
function renderSimple() {
  const T = STR[S.lang] || STR.gu;
  document.documentElement.lang = S.lang;
  document.querySelectorAll("#langs button").forEach((b) => b.classList.toggle("on", b.dataset.l === S.lang));
  $("s-title").textContent = T.title; $("a-today").textContent = T.today;
  $("p-title").textContent = T.price_t; $("i-title").textContent = T.imp_t; $("h-title").textContent = T.hit_t;
  $("q-label").textContent = T.input_l; $("q-clear").textContent = T.clear; $("wa-btn").textContent = "🟢 " + T.share;
  $("speak-btn").textContent = "🔊 " + T.listen; $("details-link").textContent = T.details;
  $("s-src").textContent = T.src; $("s-disc").textContent = T.disclaimer;
  if (!L) { $("a-main").textContent = T.nodata; return; }
  $("s-updated").textContent = fill(T.updated, { t: L.generated_ist });
  const e = est(); const c = todaysCall();
  const box = $("answer"); box.className = "answer " + (c.call === "buy now" ? "buy" : c.call === "wait" ? "wait" : "small");
  $("a-main").textContent = (c.call === "buy now" ? "✅ " + T.buy_now : c.call === "wait" ? "⏳ " + T.wait : "🟡 " + T.buy_small);
  const mvR = c.exp != null ? Math.abs(c.exp).toFixed(2) : "";
  $("a-reason").textContent = c.call === "buy now" ? fill(T.r_up, { d: S.r1Days, x: mvR }) : c.call === "wait" ? fill(T.r_down, { d: S.r1Days, x: mvR }) : T.r_flat;
  // price tile
  const ps = petSeries(); const ch7 = ps.length ? 100 * ((ps[ps.length - 1][1] - (atOrBefore(ps, addDays(ps[ps.length - 1][0], -7)) || ps[ps.length - 1][1])) / (e ? e.POY : 1)) : null;
  const arrow = ch7 == null ? "" : ch7 > 0.5 ? "⬆️" : ch7 < -0.5 ? "⬇️" : "➡️";
  $("p-big").innerHTML = e ? `₹${f2(e.POY, 1)} <span style="font-size:1.6rem">${arrow}</span>` : "—";
  $("p-big").className = "t-big " + (ch7 == null ? "" : cls(ch7, 0.5));
  $("p-sub").textContent = (e ? fill(T.trend7, { x: (ch7 > 0 ? "+" : "") + (ch7 || 0).toFixed(1) }) + " · " : "") + T.price_sub + (S.quote > 0 ? ` · ${T.your_price}: ₹${f2(S.quote, 1)}` : "");
  // import tile
  const il = importLanded(e);
  if (S.quote > 0 && il) {
    const d = il.econ - S.quote;
    $("i-main").textContent = d < 0 ? "🚢 " + fill(T.imp_cheaper, { x: f2(-d, 1) }) : "🏭 " + fill(T.dom_cheaper, { x: f2(d, 1) });
    $("i-sub").textContent = T.quote_basis;
  } else if (M && M.import_gap) {
    const g = M.import_gap.latest_gap_pct;
    $("i-main").textContent = g < -3 ? "🏭 " + T.gap_dom : g > 3 ? "🚢 " + T.gap_imp : "⚖️ " + T.gap_same;
    $("i-sub").textContent = fill(T.gap_basis, { m: M.import_gap.latest_month });
  } else { $("i-main").textContent = "—"; $("i-sub").textContent = ""; }
  // hit tile
  const h = hitInfo(c.basis);
  if (h.n >= 10) { $("h-main").textContent = "🎯 " + fill(T.hit_live, { n: h.n, k: h.k }); $("h-sub").textContent = h.bt != null ? fill(T.hit_bt, { k: h.bt }) : ""; }
  else { $("h-main").textContent = "📚 " + T.hit_learning; $("h-sub").textContent = h.bt != null ? fill(T.hit_bt, { k: h.bt }) : ""; }
  $("q-input").value = S.quote > 0 ? S.quote : "";
  // speech
  const sb = $("speak-btn"); const lang = { gu: "gu-IN", hi: "hi-IN", en: "en-IN" }[S.lang];
  const hasVoice = "speechSynthesis" in window && speechSynthesis.getVoices().some((v) => v.lang && v.lang.replace("_", "-").toLowerCase().startsWith(lang.slice(0, 2)));
  sb.style.display = hasVoice ? "" : "none";
}
function summaryText() {
  const T = STR[S.lang] || STR.gu;
  return [fill(T.wa_head, { t: L ? L.generated_ist : "" }), $("a-main").textContent, $("a-reason").textContent,
    fill(T.wa_price, { p: $("p-big").textContent.replace(/[^\d.,]/g, ""), tr: $("p-sub").textContent.split(" · ")[0] }),
    fill(T.wa_imp, { s: $("i-main").textContent.replace(/^\S+\s/, "") }), fill(T.wa_hit, { s: $("h-main").textContent.replace(/^\S+\s/, "") }),
    T.disclaimer, fill(T.wa_link, { u: location.href.split("#")[0] })].join("\n");
}

/* ---------- details: helpers ---------- */
function numIn(key, label, kind = "assume", step = "0.01", note = "") {
  return `<div class="row"><span>${label} ${pill(kind === "user" ? "input" : "assume", kind === "user" ? "your input" : "assumption")}${note ? `<br><span class="src">${note}</span>` : ""}</span><input type="number" step="${step}" data-k="${key}" class="${kind === "assume" ? "assume" : ""}" value="${S[key] == null ? "" : S[key]}"></div>`;
}
function spark(h, w = 120, hgt = 28) {
  if (!h || h.length < 2) return "";
  const v = h.map((x) => x[1]); const mn = Math.min(...v), mx = Math.max(...v); const r = mx - mn || 1;
  const pts = v.map((y, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(hgt - (y - mn) / r * hgt).toFixed(1)}`).join(" ");
  const col = v[v.length - 1] >= v[0] ? "#4ade80" : "#f87171";
  return `<svg class="spark" width="${w}" height="${hgt}"><polyline fill="none" stroke="${col}" stroke-width="1.5" points="${pts}"/></svg>`;
}
function cnyRs(k) { const it = item(k), rc = rcToday(); return it && rc ? it.value / (S.removeVat ? 1.13 : 1) * rc / 1000 : null; }
const FX_NOTE = "INR per CNY = FBIL USD/INR ÷ ECB USD/CNY";

/* ---------- 1. Today ---------- */
function rToday() {
  const e = est(); const c = todaysCall();
  const cards = [["brent", "Brent crude", (it) => "$" + f2(it.value)], ["usdinr", "USD/INR (FBIL)", (it) => "₹" + f2(it.value, 4)], ["repo", "RBI repo rate", (it) => f2(it.value) + "%"],
    ["pta", "China PTA", (it) => "₹" + f2(cnyRs("pta")) + "/kg"], ["meg", "China MEG", (it) => "₹" + f2(cnyRs("meg")) + "/kg"], ["wpi_poly_yarn", "India WPI polyester yarn", (it) => f2(it.value, 1)]];
  const cardHtml = cards.map(([k, t, fmt]) => { const it = item(k); return `<div class="card"><div class="ct">${t} ${it && it.history ? spark(it.history.slice(-90)) : ""}</div><div class="big">${it ? itemAudit(k, fmt(it)) : '<span class="grey">no live source</span>'}</div><div class="sub">${it && it.history ? (k === "wpi_poly_yarn" ? "1-month change " + pct(changeOver(it.history, 31)) : "1-month change " + pct(changeOver(it.history, 30))) + (k.length === 3 ? ` · ${f2(it.value, 0)} CNY/t` : "") : ""}</div></div>`; }).join("");
  const skuRows = ["POY", "FDY", "DTY"].map((s) => {
    const u = usedPrice(s, e);
    const f = s === "POY" ? `POY = PET cost + spread = ${f2(e && e.pet)} + ${f2(e && e.spread)}` : `${s} = POY estimate + ${s} premium (${S["prem" + s]} Rs/kg, assumption)`;
    return `<tr><td><b>${s}</b></td><td>${e ? audit("₹" + f2(e[s]), { status: "est", formula: f + "\nPET cost = (" + S.ratioPTA + "×PTA + " + S.ratioMEG + "×MEG)" + (S.removeVat ? " ÷ 1.13 (China VAT)" : "") + " × INR/CNY ÷ 1000\n" + FX_NOTE, asof: item("pta").as_of + " (PTA), " + item("meg").as_of + " (MEG), " + item("usdinr").as_of + " (FX)", source: "China futures via Sina Finance; FBIL; ECB", note: "Estimate, not a mill quote. China-cost based; Indian mill list prices can differ." }) : "—"}</td>
      <td>${s === "POY" ? (S.quote > 0 ? audit("₹" + f2(S.quote), { status: "user", asof: S.quoteDate || "", note: "Entered by you on the main screen; saved only in this browser." }) : '<span class="grey">not entered</span>') : '<span class="grey">enter in Market log</span>'}</td>
      <td>${u ? "₹" + f2(u.v) + " " + pill(u.src === "user" ? "input" : "est", u.src === "user" ? "your quote" : "estimate") : "—"}</td></tr>`;
  }).join("");
  const cal = calibSpread();
  $("s-today").innerHTML = `
  <div class="note"><b>How this thinks (3 layers).</b> <b>1. Your rules of thumb</b> (editable in tab 3, e.g. "Reliance follows PTA within a week"). <b>2. Market context</b>: crude, FX, RBI rates, China PTA/MEG, duties, official Indian price indices. <b>3. Learning loop</b>: every day it logs its calls, scores them when the time is up, and a variable only gets weight after it has shown it predicts better than "no change" (tab 8). No AI picks numbers or weights.</div>
  <div class="grid">${cardHtml}</div>
  <div class="grid2"><div class="card"><div class="ct">Yarn price today (₹/kg, before GST)</div>
    <table><tr><th>Yarn</th><th>Estimate</th><th>Your mill quote</th><th>Used in calculations</th></tr>${skuRows}</table>
    <div class="sub" style="margin-top:8px">Spread used: ₹${f2(e && e.spread)} /kg — ${cal ? `calibrated from your ${cal.n} POY deal price(s) in the Market log` : `China PSF futures minus PET cost, 60-day median (a real market spread, used as a proxy for POY) — model ${M ? M.version : ""}`}. FDY/DTY premiums are labelled assumptions; change them in tab 3.</div></div>
  <div class="card"><div class="ct">Today's call</div>
    <div class="call ${c.call === "buy now" ? "up" : c.call === "wait" ? "down" : "flat"}">${c.call === "buy now" ? "✅ Buy now" : c.call === "wait" ? "⏳ Wait" : "🟡 Buy only what you need"}</div>
    <div class="sub">Basis: ${c.basis === "model" ? "learning model (it has beaten 'no change' in the walk-forward test)" : `your rule of thumb 1 — PET cost moved ₹${f2(c.mv)} /kg in ${S.r1Days} days × ${S.r1Pass}% pass-through = expected ₹${f2(c.exp)} /kg vs ±${S.r1Band}% band. The learning model has not yet beaten 'no change', so it is not used for the call.`}</div>
    <div class="ct" style="margin-top:12px">Headlines (context only, not used in numbers)</div>
    ${(L.headlines || []).slice(0, 6).map((h) => `<div class="sub">${esc(h.date)} · <a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a></div>`).join("") || '<div class="grey">none</div>'}
    <div class="src">${esc(L.headlines_source || "")}</div></div></div>`;
}

/* ---------- 2. Trends ---------- */
function rTrend() {
  const keys = ["brent", "usdinr_ecb", "usdcny", "pta", "meg", "px", "psf"];
  const rows = keys.map((k) => { const it = item(k); if (!it) return `<tr><td>${k}</td><td colspan=6 class="grey">no live source</td></tr>`;
    return `<tr><td>${esc(it.label)}</td><td>${itemAudit(k, f2(it.value))}</td><td class="${cls(changeOver(it.history, 7))}">${pct(changeOver(it.history, 7))}</td><td class="${cls(changeOver(it.history, 30))}">${pct(changeOver(it.history, 30))}</td><td class="${cls(changeOver(it.history, 91))}">${pct(changeOver(it.history, 91))}</td><td class="${cls(changeOver(it.history, 365))}">${pct(changeOver(it.history, 365))}</td><td>${spark(it.history.slice(-250))}</td></tr>`; }).join("");
  const ps = petSeries();
  const petRow = `<tr><td><b>PET cost estimate (₹/kg)</b> ${pill("est")}</td><td>${f2(ps.length ? ps[ps.length - 1][1] : null)}</td><td class="${cls(changeOver(ps, 7))}">${pct(changeOver(ps, 7))}</td><td class="${cls(changeOver(ps, 30))}">${pct(changeOver(ps, 30))}</td><td class="${cls(changeOver(ps, 91))}">${pct(changeOver(ps, 91))}</td><td class="${cls(changeOver(ps, 365))}">${pct(changeOver(ps, 365))}</td><td>${spark(ps.slice(-250))}</td></tr>`;
  const wk = ["wpi_pta", "wpi_meg", "wpi_poly_yarn", "wpi_psf", "wpi_mmf", "wpi_poly_fabric", "wpi_synth_woven", "wpi_all"];
  const wrows = wk.map((k) => { const it = item(k); if (!it) return ""; const h = it.history; const n = h.length;
    const mom = n > 1 ? 100 * (h[n - 1][1] / h[n - 2][1] - 1) : null, m3 = n > 3 ? 100 * (h[n - 1][1] / h[n - 4][1] - 1) : null, yoy = n > 12 ? 100 * (h[n - 1][1] / h[n - 13][1] - 1) : null;
    return `<tr><td>${esc(it.label.replace("WPI: ", ""))}</td><td>${itemAudit(k, f2(it.value, 1))}</td><td>${esc(it.as_of)}</td><td class="${cls(mom)}">${pct(mom)}</td><td class="${cls(m3)}">${pct(m3)}</td><td class="${cls(yoy)}">${pct(yoy)}</td><td>${spark(h.slice(-24))}</td></tr>`; }).join("");
  const fc = [7, 30].map((h) => { const p = latest("model", h); const mh = M && M.horizons[String(h)]; if (!p || !mh) return "";
    return `<tr><td>${h} days</td><td>${esc(p.made_on)}</td><td class="${p.direction === "up" ? "up" : p.direction === "down" ? "down" : "flat"}">${p.direction} (${pct(p.pred_pct, 2)})</td><td>₹${f2(p.pred_poy_rs)} ± ${f2(p.error_band_rs)}</td><td>${mh.gate.mask.some(Boolean) ? "momentum " + mh.w_momentum + ", Brent " + mh.w_brent + " (lag " + mh.lag_days + "d), FX " + mh.w_fx : "all weights 0 → forecast = no change"}</td><td>${esc(p.model_version)}</td></tr>`; }).join("");
  $("s-trend").innerHTML = `<div class="card" style="margin-bottom:14px"><div class="ct">Live market prices — change over time</div>
   <table><tr><th>Series</th><th>Latest</th><th>1 week</th><th>1 month</th><th>3 months</th><th>1 year</th><th>Last ~1 year</th></tr>${rows}${petRow}</table>
   <div class="src">China futures are continuous main contracts (roll jumps possible). Percent changes use the last value on or before each past date.</div></div>
   <div class="card" style="margin-bottom:14px"><div class="ct">Official Indian wholesale price indices (WPI, base 2022-23 = 100)</div>
   <table><tr><th>Item</th><th>Index</th><th>Month</th><th>1 month</th><th>3 months</th><th>1 year</th><th>2 years</th></tr>${wrows}</table>
   <div class="src">Office of the Economic Adviser, DPIIT. Latest month is provisional and may be revised.</div></div>
   <div class="card"><div class="ct">Model forecast of POY estimate (from the daily ledger)</div>
   <table><tr><th>Horizon</th><th>Made on</th><th>Direction</th><th>Expected POY estimate</th><th>Weights in use</th><th>Model</th></tr>${fc}</table>
   <div class="src">Error band = 80th percentile of past errors. A forecast of "flat" with weights 0 means no variable has proven it beats "no change" yet — see tab 8.</div></div>`;
}

/* ---------- 3. Buy now or wait: your rules ---------- */
function rBuy() {
  const e = est(); const ps = petSeries(); const repo = item("repo");
  const rate = repo ? repo.value + Number(S.ccSpread) : null;
  const mv = absChangeOver(ps, Number(S.r1Days)); const exp = mv != null ? mv * S.r1Pass / 100 : null;
  const u = usedPrice("POY", e);
  const carry = u && rate ? u.v * rate / 100 * S.holdDays / 365 : null;
  const yarn = item("wpi_poly_yarn"), fab = item("wpi_poly_fabric");
  const ych = yarn ? changeOver(yarn.history, 92) : null, fch = fab ? changeOver(fab.history, 92) : null;
  const squeeze = ych != null && fch != null && ych > fch + 1;
  const il = importLanded(e); const gap = il && u ? u.v - il.econ : null;
  const r1 = M && M.rule1 ? M.rule1.backtest : null;
  const rules = [
    [`1. Mills (Reliance etc.) pass PTA/MEG cost changes into POY within <b>${S.r1Days}</b> days, at <b>${S.r1Pass}%</b>.`, exp == null ? "—" : `PET cost moved ₹${f2(mv)} in ${S.r1Days} days → expected POY move ₹${f2(exp)} /kg`, exp == null ? "" : exp > (u ? u.v * S.r1Band / 100 : 1) ? pill("live", "price likely up") : exp < -(u ? u.v * S.r1Band / 100 : 1) ? pill("bad", "price likely down") : pill("input", "no big move"),
      r1 ? `Back-test since ${r1.start}: right ${r1.hit_rate}% of ${r1.n} days (default 7 days/100%, China data).` : ""],
    [`2. Buy ahead only if the expected rise beats the interest cost of holding stock for <b>${S.holdDays}</b> days.`, carry == null ? "—" : `Interest to hold: ₹${f2(carry)} /kg (rate ${f2(rate)}% = repo ${f2(repo.value)}% + your spread ${S.ccSpread}%)`, exp == null || carry == null ? "" : exp > carry ? pill("live", "buying ahead pays") : pill("bad", "buying ahead does not pay"), "Not scorable against mill prices (not public)."],
    [`3. Don't stock up if weavers' cloth prices fall behind yarn prices (official WPI, 3 months).`, ych == null ? "—" : `Polyester yarn ${pct(ych)} vs polyester filament fabric ${pct(fch)} (to ${yarn.as_of})`, ych == null ? "" : squeeze ? pill("bad", "weavers squeezed") : pill("live", "no squeeze"), "Official monthly data."],
    [`4. Import only if landed cost is at least ₹<b>${S.r4Min}</b>/kg below domestic.`, gap == null ? "—" : `Domestic ${u.src === "user" ? "(your quote)" : "(estimate)"} − import landed = ₹${f2(gap)} /kg`, gap == null ? "" : gap >= S.r4Min ? pill("live", "import") : pill("input", "buy domestic"), u && u.src !== "user" ? "Enter your mill quote for a real comparison: the estimate and the import cost come from the same China price." : ""],
    [`5. Always keep at least <b>${S.r5Cash}%</b> of trading capital in cash.`, "Used in tab 5", "", ""]];
  const hurdle = ["POY", "FDY", "DTY"].map((s) => { const p = usedPrice(s, e); if (!p || rate == null) return "";
    const sell = p.v + (exp || 0); const fin = p.v * rate / 100 * S.holdDays / 365; const net = sell - p.v - fin - S.storageRs - S.bufferRs;
    return `<tr><td><b>${s}</b></td><td>₹${f2(p.v)} ${pill(p.src === "user" ? "input" : "est", p.src === "user" ? "quote" : "estimate")}</td><td>${audit("₹" + f2(sell), { status: "est", formula: `buy price + rule-1 expected move (₹${f2(exp)})` })}</td><td>-₹${f2(fin)}</td><td>-₹${f2(S.storageRs)}</td><td>-₹${f2(S.bufferRs)}</td><td class="${cls(net)}"><b>₹${f2(net)}</b> ${net > 0 ? pill("live", "positive carry") : pill("bad", "negative carry")}</td></tr>`; }).join("");
  $("s-buy").innerHTML = `<div class="grid2"><div class="card"><div class="ct">Layer 1 — your rules of thumb (edit the numbers)</div>
   <table><tr><th>Rule</th><th>Today</th><th>Result</th><th>Evidence</th></tr>${rules.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td class="src">${r[3]}</td></tr>`).join("")}</table></div>
   <div class="card"><div class="ct">Rule settings</div>
   ${numIn("r1Days", "Rule 1: days for mills to follow PTA/MEG", "assume", "1")}${numIn("r1Pass", "Rule 1: pass-through %", "assume", "5")}${numIn("r1Band", "Rule 1: ignore moves smaller than (% of price)", "assume", "0.1")}
   ${numIn("holdDays", "Rule 2: days you hold stock", "user", "1")}${numIn("ccSpread", "Rule 2: your bank rate above RBI repo (%)", "assume", "0.25", "Typical MSME cash-credit spread; check your sanction letter")}
   ${numIn("r4Min", "Rule 4: minimum import saving (₹/kg)", "assume", "0.25")}${numIn("r5Cash", "Rule 5: minimum cash (%)", "assume", "1")}
   ${numIn("premFDY", "FDY premium over POY (₹/kg)", "assume", "0.5", "Unsourced default from the original mockup's example prices; replace with what you see")}${numIn("premDTY", "DTY premium over POY (₹/kg)", "assume", "0.5", "Same — unsourced default")}
   ${numIn("storageRs", "Godown & handling (₹/kg)", "assume")}${numIn("bufferRs", "Defect / liquidation buffer (₹/kg)", "assume")}</div></div>
   <div class="card"><div class="ct">Is holding stock worth it? (per kg, ${S.holdDays} days)</div>
   <table><tr><th>Yarn</th><th>Buy price</th><th>Expected price</th><th>Interest</th><th>Godown</th><th>Buffer</th><th>Net</th></tr>${hurdle}</table>
   <div class="formula">Interest = buy price × (repo + your spread) × days ÷ 365. Original mockup showed ₹1.60/kg for POY at 10.5% for 30 days; the correct figure for ₹105 is ₹0.91.</div></div>`;
}

/* ---------- 4. Import vs domestic ---------- */
function rImport() {
  const e = est(); const il = importLanded(e); const u = usedPrice("POY", e); const fx = item("usdinr");
  if (!e || !il) { $("s-import").innerHTML = '<div class="card grey">Live China price or FX missing — cannot estimate.</div>'; return; }
  const r = (l, v, a) => `<tr><td>${l}</td><td>${a ? audit("₹" + f2(v), a) : "₹" + f2(v)}</td></tr>`;
  const cifUSD = il.av * 1000 / fx.value;
  const g = M && M.import_gap;
  $("s-import").innerHTML = `<div class="grid2"><div class="card"><div class="ct">Landed cost of imported POY (₹/kg)</div>
   <div class="warn">The import price is an <b>estimate</b>: China POY-equivalent cost (₹${f2(e.POY)}) + your freight assumption. Use your actual CIF quote if you have one: enter it as freight = CIF − estimate.</div>
   <table><tr><th>Item</th><th>₹/kg</th></tr>
   ${r("CIF value (China price + freight & insurance)", il.av, { status: "est", formula: `POY estimate ${f2(e.POY)} + freight ${S.freightRs}`, note: `≈ US$${f2(cifUSD, 0)}/tonne at FBIL ₹${f2(fx.value, 4)}` })}
   ${r(`Basic customs duty ${R.bcd_pct.value}%`, il.B, { status: "official", source: R.bcd_pct.source, url: R.bcd_pct.url, asof: "verified " + R.verified_on, formula: "CIF × BCD%" })}
   ${r(`AIDC ${R.aidc_pct.value}%`, il.A, { status: "official", source: R.aidc_pct.source, url: R.aidc_pct.url, asof: "verified " + R.verified_on })}
   ${r(`Social welfare surcharge ${R.sws_pct_of_bcd.value}% of BCD+AIDC`, il.W, { status: "official", source: R.sws_pct_of_bcd.source, url: R.sws_pct_of_bcd.url, asof: "verified " + R.verified_on })}
   ${r("Anti-dumping duty", il.add, { status: "official", source: R.add.source, url: R.add.url, asof: "verified " + R.verified_on })}
   ${r("Port, CFS & CHA", Number(S.portRs), { status: "assume", note: "Unsourced default from the original mockup; replace with your CHA bill" })}
   ${r("Truck to Surat", Number(S.inlandRs), { status: "assume", note: "Unsourced default; replace" })}
   ${r("Demurrage / FX / quality buffers", Number(S.otherRs), { status: "assume", note: "Unsourced default; replace" })}
   ${r(`Transit interest (${S.transitDays} days @ ${S.lcRate}%)`, il.fin, { status: "est", formula: "CIF × rate × days ÷ 365" })}
   <tr style="font-weight:700"><td>Economic landed cost (IGST is claimed back as credit)</td><td>₹${f2(il.econ)}</td></tr>
   ${r(`IGST ${R.igst_pct.value}% (cash at customs, recoverable)`, il.I, { status: "official", source: R.igst_pct.source, url: R.igst_pct.url, asof: "verified " + R.verified_on, formula: "(CIF + BCD + AIDC + SWS + ADD) × IGST%" })}
   <tr style="font-weight:700"><td>Cash landed cost</td><td>₹${f2(il.cash)}</td></tr></table>
   <div class="src">${esc(R.note)} ${esc(R.qco.source)} <a href="${R.qco.url}" target="_blank" rel="noopener">Gazette</a>. Original mockup used 12% IGST; it has been 5% since 22 Sep 2025.</div></div>
   <div class="card"><div class="ct">Compare</div>
   <div class="box"><div class="sub">Domestic POY ${u.src === "user" ? "(your quote)" : "(estimate)"} − import landed</div><div class="big ${cls(u.v - il.econ)}">₹${f2(u.v - il.econ)} /kg</div>
   <div class="sub">${u.src === "user" ? (u.v - il.econ > 0 ? "Import is cheaper on these numbers." : "Domestic is cheaper on these numbers.") : "Not a real comparison until you enter a mill quote: both sides come from the same China price."}</div></div>
   <div class="box"><div class="sub">Working capital for ${S.fcl} tonnes (cash landed)</div><div class="big">₹${f2(il.cash * S.fcl * 1000 / 1e5)} lakh</div><div class="sub">of which IGST ₹${f2(il.I * S.fcl * 1000 / 1e5)} lakh is locked until set off against your output GST.</div></div>
   ${g ? `<div class="box"><div class="sub">Official check: Indian WPI polyester yarn vs China-landed cost, both rebased to ${g.base_months}</div><div class="big ${cls(g.latest_gap_pct)}">${pct(g.latest_gap_pct)}</div><div class="sub">${g.latest_month}: ${g.latest_gap_pct < -3 ? "Indian yarn is cheaper than usual relative to imports" : g.latest_gap_pct > 3 ? "Indian yarn is dearer than usual relative to imports" : "normal gap"}. ${spark(g.series, 200, 30)}</div></div>` : ""}
   ${numIn("freightRs", "Freight & insurance China→India (₹/kg)", "assume", "0.1", "Unsourced default; ask your forwarder")}${numIn("portRs", "Port/CFS/CHA (₹/kg)", "assume")}${numIn("inlandRs", "Truck to Surat (₹/kg)", "assume")}${numIn("otherRs", "Buffers (₹/kg)", "assume")}${numIn("transitDays", "Transit days", "assume", "1")}${numIn("lcRate", "LC / usance interest (%)", "assume", "0.1")}${numIn("fcl", "Lot size (tonnes)", "user", "1")}</div></div>`;
}

/* ---------- 5. Allocation ---------- */
function rAlloc() {
  const sk = ["POY", "FDY", "DTY"]; const m = { POY: +S.mPOY, FDY: +S.mFDY, DTY: +S.mDTY };
  const act = sk.filter((s) => m[s] >= S.hurdle); const tot = act.reduce((a, s) => a + m[s], 0); const maxInv = 1 - S.r5Cash / 100;
  const w = {}; sk.forEach((s) => w[s] = act.includes(s) && tot > 0 ? Math.min(S.maxSku / 100, maxInv * m[s] / tot) : 0);
  const inv = sk.reduce((a, s) => a + w[s], 0); const cap = +S.capital;
  const pnl = sk.reduce((a, s) => a + cap * w[s] * m[s] / 100, 0);
  const psf = ser("psf"); const moves = [];
  for (let i = 0; i < psf.length; i++) { const p = atOrBefore(psf, addDays(psf[i][0], 30)); const j = psf.findIndex((x) => x[0] >= addDays(psf[i][0], 30)); if (j > 0) moves.push(100 * (psf[j][1] / psf[i][1] - 1)); }
  moves.sort((a, b) => a - b); const p5 = moves.length ? moves[Math.floor(moves.length * 0.05)] : null;
  const tail = moves.length ? moves.slice(0, Math.max(1, Math.floor(moves.length * 0.05))) : []; const cvar = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : null;
  const e = est();
  $("s-alloc").innerHTML = `<div class="grid2"><div class="card"><div class="ct">Stock allocation calculator (on your assumptions)</div>
   <div class="note">This is a calculator, not an optimiser: capital goes to yarns whose expected margin (your input) clears the hurdle, in proportion to margin, capped per yarn, keeping your minimum cash.</div>
   ${numIn("capital", "Trading capital (₹)", "user", "100000")}${numIn("mPOY", "POY expected 30-day margin (%)", "user", "0.1")}${numIn("mFDY", "FDY expected 30-day margin (%)", "user", "0.1")}${numIn("mDTY", "DTY expected 30-day margin (%)", "user", "0.1")}${numIn("hurdle", "Minimum margin to stock (%)", "user", "0.1")}${numIn("maxSku", "Max per yarn (%)", "user", "1")}
   <div class="sub">Minimum cash ${S.r5Cash}% comes from rule 5 (tab 3).</div></div>
   <div class="card"><div class="ct">Result</div><table><tr><th>Yarn</th><th>Share</th><th>₹ lakh</th><th>Tonnes</th><th>Status</th></tr>
   ${sk.map((s) => { const p = usedPrice(s, e); return `<tr><td>${s}</td><td>${(w[s] * 100).toFixed(1)}%</td><td>${f2(cap * w[s] / 1e5)}</td><td>${p ? f2(cap * w[s] / p.v / 1000, 1) : "—"}</td><td>${w[s] > 0 ? pill("live", "stock") : pill("bad", "below hurdle")}</td></tr>`; }).join("")}
   <tr><td><b>Cash</b></td><td>${((1 - inv) * 100).toFixed(1)}%</td><td>${f2(cap * (1 - inv) / 1e5)}</td><td>—</td><td></td></tr></table>
   <div class="box" style="margin-top:10px"><div class="row"><span>Expected 30-day profit (your margins)</span><b>₹${f2(pnl / 1e5)} lakh</b></div>
   <div class="row"><span>Bad-month loss (5% worst 30-day move of China PSF futures, ${moves.length} windows)</span><b class="down">${p5 == null ? "—" : "₹" + f2(cap * inv * p5 / 100 / 1e5) + " lakh (" + pct(p5) + ")"}</b></div>
   <div class="row"><span>Average loss in that worst 5% (historical CVaR)</span><b class="down">${cvar == null ? "—" : "₹" + f2(cap * inv * cvar / 100 / 1e5) + " lakh (" + pct(cvar) + ")"}</b></div>
   <div class="src">Risk uses real price history of China polyester staple fibre futures as a stand-in for yarn price risk (Indian POY price history is not public). The original mockup's covariance matrix was invented and has been removed.</div></div></div></div>`;
}

/* ---------- 6. What-if ---------- */
function beta(xk, yk) {
  const x = ser(xk), y = ser(yk); if (x.length < 60 || y.length < 60) return null;
  const pts = []; const last = y[y.length - 1][0]; let d = y[0][0];
  while (addDays(d, 30) <= last) { const x0 = atOrBefore(x, d), x1 = atOrBefore(x, addDays(d, 30)), y0 = atOrBefore(y, d), y1 = atOrBefore(y, addDays(d, 30)); if (x0 && x1 && y0 && y1) pts.push([x1 / x0 - 1, y1 / y0 - 1]); d = addDays(d, 30); }
  const n = pts.length; if (n < 10) return null; const mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  const cov = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0), vx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0), vy = pts.reduce((a, p) => a + (p[1] - my) ** 2, 0);
  return { b: cov / vx, r2: cov * cov / (vx * vy), n };
}
function rWhatif() {
  const e = est(); const bP = beta("brent", "pta"), bM = beta("brent", "meg"); const repo = item("repo");
  if (!e) { $("s-whatif").innerHTML = '<div class="card grey">Live data missing.</div>'; return; }
  const ptaPct = (bP ? bP.b * S.simBrent : 0) + Number(S.simPTA), megPct = (bM ? bM.b * S.simBrent : 0) + Number(S.simMEG);
  const fx = Number(S.simFX) / 100;
  const pet1 = (S.ratioPTA * e.ptaRs * (1 + ptaPct / 100) + S.ratioMEG * e.megRs * (1 + megPct / 100)) * (1 + fx);
  const dPet = pet1 - e.pet; const dPoy = dPet * S.simPass / 100; const u = usedPrice("POY", e);
  const rate = repo ? repo.value + Number(S.ccSpread) : 0; const finD = (u.v + dPoy) * rate / 100 * (S.simCredit - 30) / 365;
  const pnl = S.simKg * (dPoy - finD);
  const sl = (k, l, mn, mx, st, unit) => `<div class="row" style="display:block"><div class="row"><span>${l}</span><b>${S[k] > 0 ? "+" : ""}${S[k]}${unit}</b></div><input type="range" data-k="${k}" min="${mn}" max="${mx}" step="${st}" value="${S[k]}"></div>`;
  $("s-whatif").innerHTML = `<div class="grid2"><div class="card"><div class="ct">Shocks</div>
   ${sl("simBrent", "Brent crude change", -30, 30, 5, "%")}${sl("simPTA", "Extra PTA change (beyond crude)", -20, 20, 1, "%")}${sl("simMEG", "Extra MEG change (beyond crude)", -20, 20, 1, "%")}${sl("simFX", "Rupee vs dollar/yuan (+ = rupee weaker)", -6, 6, 0.5, "%")}${sl("simCredit", "Credit you give weavers (days)", 0, 90, 5, "")}${sl("simPass", "How much mills pass on (%)", 0, 120, 10, "")}
   ${numIn("simKg", "Your stock (kg)", "user", "1000")}
   <div class="src">Brent→PTA sensitivity ${bP ? f2(bP.b, 2) + " (R² " + f2(bP.r2, 2) + ", " + bP.n + " monthly windows)" : "n/a"}; Brent→MEG ${bM ? f2(bM.b, 2) + " (R² " + f2(bM.r2, 2) + ")" : "n/a"}. Computed in your browser from the fetched price history — not assumed.</div></div>
   <div class="card"><div class="ct">Result</div>
   <div class="box"><div class="sub">1. PET raw-material cost</div><div class="big ${cls(dPet)}">${dPet >= 0 ? "+" : ""}₹${f2(dPet)} /kg</div><div class="sub">PTA ${pct(ptaPct)}, MEG ${pct(megPct)}, FX ${pct(fx * 100)} → PET ₹${f2(e.pet)} → ₹${f2(pet1)}</div></div>
   <div class="box"><div class="sub">2. Expected POY price change (× ${S.simPass}% pass-on)</div><div class="big ${cls(dPoy)}">${dPoy >= 0 ? "+" : ""}₹${f2(dPoy)} /kg</div><div class="sub">POY ₹${f2(u.v)} → ₹${f2(u.v + dPoy)}</div></div>
   <div class="box"><div class="sub">3. Extra interest from credit beyond 30 days</div><div class="big ${cls(-finD)}">₹${f2(-finD)} /kg</div><div class="sub">at ${f2(rate)}% (repo + ${S.ccSpread}%)</div></div>
   <div class="box"><div class="sub">4. Effect on your ${Number(S.simKg).toLocaleString("en-IN")} kg stock</div><div class="big ${cls(pnl)}">₹${Math.round(pnl).toLocaleString("en-IN")}</div><div class="sub">stock × (price change − extra interest). Original mockup's sigmoid elasticity, loom drag and inventory-days terms had invented coefficients and were removed.</div></div></div></div>`;
}

/* ---------- 7. Market log ---------- */
function rLog() {
  const rows = (S.log || []).slice().sort((a, b) => a.date < b.date ? 1 : -1);
  const bySku = {}; rows.forEach((r) => (bySku[r.sku] = bySku[r.sku] || []).push(r));
  const acc = Object.entries(bySku).map(([s, xs]) => { if (xs.length < 2 || !(xs[0].list > 0 && xs[1].list > 0)) return ""; const dl = xs[0].list - xs[1].list, dd = xs[0].deal - xs[1].deal;
    return `<div class="box"><b>${s}</b>: list ${dl >= 0 ? "+" : ""}₹${f2(dl)}, deals ${dd >= 0 ? "+" : ""}₹${f2(dd)} → ${dl !== 0 ? "price acceptance " + Math.round(100 * dd / dl) + "%" : "no list change"} (${xs[1].date} → ${xs[0].date})</div>`; }).join("");
  const c = calibSpread();
  $("s-log").innerHTML = `<div class="grid2"><div class="card"><div class="ct">Add what you saw in the market ${pill("input", "your input")}</div>
   <div class="row"><span>Date</span><input type="date" id="lg-d" value="${new Date().toISOString().slice(0, 10)}" style="width:150px"></div>
   <div class="row"><span>Yarn</span><select id="lg-s"><option>POY</option><option>FDY</option><option>DTY</option></select></div>
   <div class="row"><span>Mill list price (₹/kg)</span><input type="number" id="lg-l" step="0.25"></div>
   <div class="row"><span>Actual deal price (₹/kg)</span><input type="number" id="lg-p" step="0.25"></div>
   <div class="row"><span>Grey fabric price (₹/m, optional)</span><input type="number" id="lg-f" step="0.1"></div>
   <div class="row"><span>Note</span><input type="text" id="lg-n" style="width:180px"></div>
   <button class="btn" id="lg-add">Add</button> <button class="btn ghost" id="lg-csv">Download my log (CSV)</button>
   <div class="src" style="margin-top:8px">Saved only in this browser. ${c ? `Your ${c.n} POY deal price(s) now calibrate the spread: ₹${f2(c.spread)} /kg over PET cost.` : "POY deal prices you enter here replace the China-proxy spread with your own (median of deal price − PET cost on that date)."}</div></div>
   <div class="card"><div class="ct">Mill list vs actual deals</div>${acc || '<div class="grey">Add two entries for the same yarn to see price acceptance.</div>'}
   <table><tr><th>Date</th><th>Yarn</th><th>List</th><th>Deal</th><th>Discount</th><th>Fabric</th><th>Note</th><th></th></tr>
   ${rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.sku)}</td><td>${f2(r.list)}</td><td>${f2(r.deal)}</td><td>${r.list > 0 && r.deal > 0 ? f2(r.deal - r.list) : "—"}</td><td>${r.fabric ? f2(r.fabric) : "—"}</td><td>${esc(r.note || "")}</td><td><button class="btn ghost" data-del="${r.id}">✕</button></td></tr>`).join("")}</table>
   <div class="src">Cluster shift status and collection days from the original mockup had no public source and were removed; record them here as notes if useful.</div></div></div>`;
  $("lg-add").onclick = () => { const r = { id: Date.now(), date: $("lg-d").value, sku: $("lg-s").value, list: +$("lg-l").value || null, deal: +$("lg-p").value || null, fabric: +$("lg-f").value || null, note: $("lg-n").value };
    if (!r.date || !(r.list || r.deal)) return alert("Enter a date and at least one price."); S.log.push(r); save(); renderAll(); };
  $("lg-csv").onclick = () => download("sttie_my_market_log.csv", toCSV(S.log, ["date", "sku", "list", "deal", "fabric", "note"]));
  document.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => { S.log = S.log.filter((r) => String(r.id) !== b.dataset.del); save(); renderAll(); });
}

/* ---------- 8. Track record ---------- */
function rTrack() {
  const ps = P ? P.predictions : []; const sc = ps.filter((p) => p.scored);
  const grp = (f) => { const xs = sc.filter(f); return { n: xs.length, hit: xs.length ? Math.round(100 * xs.filter((p) => p.hit_buy_call ?? p.hit_direction).length / xs.length) : null, mae: xs.length ? xs.reduce((a, p) => a + Math.abs(p.error_rs || 0), 0) / xs.length : null }; };
  const g7 = grp((p) => !p.kind && p.horizon_days === 7), g30 = grp((p) => !p.kind && p.horizon_days === 30), gr = grp((p) => p.kind === "rule1");
  const stat = (g, l) => `<div class="card"><div class="ct">${l}</div>${g.n < 10 ? `<div class="big flat">Learning</div><div class="sub">too few results yet (${g.n} scored)</div>` : `<div class="big">${g.hit}%</div><div class="sub">right, over ${g.n} scored calls · avg error ₹${f2(g.mae)} /kg</div>`}</div>`;
  const bt = M ? M.backtest : {}; const rb = M && M.rule1 ? M.rule1.backtest : null;
  const vars = M ? ["7", "30"].map((h) => { const m = M.horizons[h]; return ["momentum", "brent", "fx"].map((v, j) => `<tr><td>${h} days</td><td>${v === "momentum" ? "Recent PET cost trend" : v === "brent" ? "Brent crude (lag " + m.lag_days + " d)" : "Rupee per yuan"}</td><td><b>${[m.w_momentum, m.w_brent, m.w_fx][j]}</b></td><td>${m.gate.mask[j] ? pill("live", "has weight") : pill("none", "no weight")}</td><td class="src">${esc(m.gate.why[v] || "")}</td></tr>`).join(""); }).join("") : "";
  const recent = ps.slice().reverse().slice(0, 40).map((p) => `<tr><td>${esc(p.made_on)}</td><td>${p.kind === "rule1" ? "Rule 1" : "Model " + p.horizon_days + "d"}</td><td>${esc(p.buy_call)}${p.direction ? " · " + p.direction : ""}${p.import_call ? " · " + esc(p.import_call) : ""}</td><td>₹${f2(p.kind === "rule1" ? p.inputs.poy_rs + p.expected_move_rs : p.pred_poy_rs)}</td><td>${esc(p.target_date)}</td><td>${p.scored ? "₹" + f2(p.realised_poy_rs) : '<span class="grey">pending</span>'}</td><td>${p.scored ? ((p.hit_buy_call ?? p.hit_direction) ? pill("live", "hit") : pill("bad", "miss")) : ""}</td><td>${p.scored ? "₹" + f2(p.error_rs) : ""}</td><td>${esc(p.model_version)}</td></tr>`).join("");
  $("s-track").innerHTML = `<div class="note">Every scheduled run logs dated calls to <a href="data/predictions.json">data/predictions.json</a> with their inputs and model version. When the horizon passes, the same public sources score them. Weights are re-fitted only on realised data; a variable keeps weight only if it cut out-of-sample error by at least 1% and the whole model beats "assume no change". Scores are against the China-cost POY estimate, not private mill quotes (there is no backend to collect those).</div>
   <div class="grid">${stat(gr, "Rule 1 calls (7 days) — live")}${stat(g7, "Model 7-day — live")}${stat(g30, "Model 30-day — live")}
   <div class="card"><div class="ct">Back-test (real fetched history)</div><div class="sub">${rb ? `Rule 1: right ${rb.hit_rate}% of ${rb.n} days since ${rb.start}.<br>` : ""}${["7", "30"].map((h) => bt[h] ? `Model ${h}d: direction right ${bt[h].hit_rate}% vs ${bt[h].naive_hit_rate}% for "no change"; avg error ₹${bt[h].mae_rs} vs ₹${bt[h].naive_mae_rs} (${bt[h].n} calls, ${bt[h].start}–${bt[h].end})` : "").join("<br>")}</div><div class="src">Labelled back-test: walk-forward, each call uses only data before it.</div></div></div>
   <div class="grid2"><div class="card"><div class="ct">Layer 3 — each variable's weight and why (model ${M ? M.version : ""})</div><table><tr><th>Horizon</th><th>Variable</th><th>Weight</th><th></th><th>Why</th></tr>${vars}</table></div>
   <div class="card"><div class="ct">Current lessons</div>${M ? M.lessons.map((l) => `<div class="sub" style="margin-bottom:6px">• ${esc(l)}</div>`).join("") : ""}
   <div class="ct" style="margin-top:10px">What the model changed and why</div>${M ? M.changelog.slice(0, 15).map((c) => `<div class="sub" style="margin-bottom:6px"><b>${esc(c.date)} · ${esc(c.version)}</b><br>${c.changes.map(esc).join("<br>")}</div>`).join("") : ""}
   <div class="src">Archived model files: data/models/. All lesson text is fixed templates filled with computed numbers; no AI writes or picks anything.</div></div></div>
   <div class="card"><div class="ct">Recent calls, including misses <a class="btn ghost" href="data/track_record.csv" download>Download track record (CSV)</a></div>
   <table><tr><th>Made on</th><th>Type</th><th>Call</th><th>Expected POY est.</th><th>Due</th><th>Actual</th><th>Result</th><th>Error</th><th>Model</th></tr>${recent}</table></div>`;
}

/* ---------- 9. Sources ---------- */
function rSources() {
  const rows = Object.entries(L.items).map(([k, it]) => `<tr><td>${esc(it.label)}</td><td>${pill(it.status === "stale" ? "stale" : it.status)}</td><td>${f2(it.value, it.value < 20 ? 4 : 2)} ${esc(it.unit)}</td><td>${esc(it.as_of)}</td><td><a href="${esc(it.source_url)}" target="_blank" rel="noopener">${esc(it.source)}</a></td></tr>`).join("");
  const na = [["Reliance / Garden POY-FDY-DTY list prices", "Not public (circulars go to dealers). Fibre2Fashion blocks automated access; only dated headlines via Google News RSS are shown, as context."], ["Surat grey fabric spot rates", "No public dated source. Enter in Market log."], ["China filament inventory days (CCFGroup)", "Paid subscription. Removed."], ["Loom run rate / cluster shift status / collection days", "No public source. Removed."], ["DGCIS monthly import value & volume by HS code", "Official, but only through an interactive form (tradestat.commerce.gov.in) with no stable download; not automated."], ["CBIC customs notified exchange rate", "Official, published as notification PDFs; FBIL rate is used instead (difference usually under 0.5%)."], ["Ocean freight China→India", "No free dated index; assumption you can edit."]];
  $("s-sources").innerHTML = `<div class="card" style="margin-bottom:14px"><div class="ct">Every data item <span class="sub">data refreshed ${esc(L.generated_ist)}</span></div><table><tr><th>Item</th><th>Status</th><th>Value</th><th>As of</th><th>Source</th></tr>${rows}
   ${["bcd_pct", "sws_pct_of_bcd", "aidc_pct", "igst_pct", "add"].map((k) => `<tr><td>Duty: ${k.replace("_pct", "").replace("_of_bcd", "").toUpperCase()}</td><td>${pill("official")}</td><td>${R[k].value}${k === "add" ? " ₹/kg" : "%"}</td><td>verified ${R.verified_on}</td><td><a href="${R[k].url}" target="_blank" rel="noopener">${esc(R[k].source)}</a></td></tr>`).join("")}
   ${na.map(([a, b]) => `<tr><td>${a}</td><td>${pill("none", "no live source")}</td><td class="grey">—</td><td></td><td class="src">${b}</td></tr>`).join("")}</table>
   ${Object.keys(L.errors || {}).length ? `<div class="warn">Last refresh errors: ${esc(JSON.stringify(L.errors))}</div>` : '<div class="src">Last refresh: all sources OK.</div>'}</div>
   <div class="grid2"><div class="card"><div class="ct">Formulas</div><div class="formula">${esc(M ? M.formula : "")}

Landed (economic) = CIF + BCD + AIDC + SWS + ADD + port + truck + buffers + transit interest
Cash landed = economic + IGST, IGST = (CIF + BCD + AIDC + SWS + ADD) × IGST%
Holding interest = price × (repo + your spread) × days / 365
Rule 1 expected move = (PET today − PET N days ago) × pass-through%</div><p class="sub" style="margin-top:8px"><a href="methodology.html">Full methodology →</a></p></div>
   <div class="card"><div class="ct">Refresh schedule</div><div class="sub">GitHub Actions runs at 08:30, 14:30 and 20:30 IST every day (03:00, 09:00, 15:00 UTC), fetches all sources, logs and scores predictions, re-fits the model and commits the JSON. Cost: zero (public repo). If a source fails, the last good value is kept and shown as <span class="pill p-stale">stale</span>.</div>
   <div class="ct" style="margin-top:12px">Disclaimer</div><div class="sub">Decision support, not investment, trading or credit advice. Estimates are built from China futures and official Indian data and can differ from actual Surat mill prices. Check prices with your supplier and duties on ICEGATE before any deal.</div></div></div>`;
}

/* ---------- plumbing ---------- */
function toCSV(rows, cols) { return [cols.join(",")].concat(rows.map((r) => cols.map((c) => { const v = r[c] == null ? "" : String(r[c]); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(","))).join("\n"); }
function download(name, text) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = name; a.click(); }
function renderDetails() {
  $("meta-data").innerHTML = `Data refreshed: <b>${esc(L.generated_ist)}</b>`;
  $("meta-model").textContent = M ? `Model ${M.version} · fitted ${M.updated_ist}` : "";
  const errs = Object.keys(L.errors || {}); $("err").style.display = errs.length ? "" : "none"; $("err").textContent = errs.length ? "Some sources failed on the last refresh and show their last good value (stale): " + errs.join(", ") : "";
  [rToday, rTrend, rBuy, rImport, rAlloc, rWhatif, rLog, rTrack, rSources].forEach((f) => { try { f(); } catch (e) { console.error(f.name, e); } });
}
function renderAll() { renderSimple(); if (location.hash === "#details" || location.hash.startsWith("#tab-")) renderDetails(); }
function route() {
  const det = location.hash === "#details" || location.hash.startsWith("#tab-");
  $("simple").style.display = det ? "none" : ""; $("details").style.display = det ? "" : "none";
  if (det && L) { renderDetails(); const t = location.hash.startsWith("#tab-") ? location.hash.slice(5) : null; if (t) showTab(t); }
  window.scrollTo(0, 0);
}
function showTab(s) { document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.s === s)); document.querySelectorAll(".screen").forEach((x) => x.classList.toggle("active", x.id === "s-" + s)); }
document.addEventListener("click", (ev) => {
  const t = ev.target.closest(".tab"); if (t) { showTab(t.dataset.s); history.replaceState(null, "", "#tab-" + t.dataset.s); }
  const l = ev.target.closest("#langs button"); if (l) { S.lang = l.dataset.l; save(); renderSimple(); }
});
document.addEventListener("change", (ev) => { const k = ev.target.dataset && ev.target.dataset.k; if (k) { S[k] = ev.target.value === "" ? null : Number(ev.target.value); save(); setTimeout(renderAll, 0); } });
document.addEventListener("input", (ev) => { if (ev.target.type === "range" && ev.target.dataset.k) { S[ev.target.dataset.k] = Number(ev.target.value); save(); rWhatif(); } });
$("back-link").onclick = (e) => { e.preventDefault(); history.pushState(null, "", location.pathname); route(); };
window.addEventListener("hashchange", route);
$("q-input").addEventListener("change", () => { const v = Number($("q-input").value); S.quote = v >= 40 && v <= 300 ? v : null; S.quoteDate = S.quote ? new Date().toISOString().slice(0, 10) : null; save(); setTimeout(renderAll, 0); });
$("q-clear").onclick = () => { S.quote = null; S.quoteDate = null; save(); renderAll(); };
$("wa-btn").onclick = () => window.open("https://wa.me/?text=" + encodeURIComponent(summaryText()), "_blank");
$("speak-btn").onclick = () => { const u = new SpeechSynthesisUtterance([$("a-main").textContent, $("a-reason").textContent, $("p-title").textContent, $("p-big").textContent, $("i-main").textContent].join(". ").replace(/[✅⏳🟡⬆️⬇️➡️🚢🏭⚖️]/gu, ""));
  u.lang = { gu: "gu-IN", hi: "hi-IN", en: "en-IN" }[S.lang]; speechSynthesis.cancel(); speechSynthesis.speak(u); };
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = renderSimple;

const j = (u) => fetch(u + "?t=" + Date.now()).then((r) => { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); });
Promise.all([j("data/live.json"), j("data/model.json").catch(() => null), j("data/predictions.json").catch(() => null), j("data/rates.json")])
  .then(([l, m, p, r]) => { L = l; M = m; P = p; R = r; renderSimple(); route(); })
  .catch((e) => { console.error(e); renderSimple(); $("a-reason").textContent = String(e); });
renderSimple();
})();
