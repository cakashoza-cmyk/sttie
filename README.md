# STTIE · Surat Yarn Desk

Public, zero-cost decision-support tool for Surat polyester yarn traders: estimated POY/FDY/DTY price from live China PTA/MEG futures and official FX, buy-now-or-wait call, import vs domestic, and a self-scoring track record.

Live: https://cakashoza-cmyk.github.io/sttie/ · Methodology: methodology.html

- `scripts/fetch.py` fetches public data into `data/live.json` (FRED/EIA, RBI/FBIL, ECB, Sina futures feed, OEA WPI, Google News RSS headlines).
- `scripts/model.py` logs dated predictions (`data/predictions.json`), scores matured ones, re-fits weights on realised data, and writes `data/model.json`, `data/models/` and `data/track_record.csv`.
- `.github/workflows/refresh.yml` runs both at 08:30, 14:30 and 20:30 IST.

No keys, no backend, no AI-generated numbers. User entries stay in the browser (localStorage). Not investment advice.
