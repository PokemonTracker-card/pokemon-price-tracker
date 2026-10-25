# PokéPrice — Pokémon TCG price tracker

Local: `npm ci && npm start` (PORT env, default 8787). Data goes to `./data` (JSON files) unless `DATABASE_URL` is set.
`./start.sh` = local server + cloudflared quick tunnel (see "Public URL note").

## Data sources (no API keys)
- TCGCSV (tcgcsv.com) — daily mirror of TCGplayer prices/products, English (cat 3) + Japanese (cat 85). Updated ~20:00 UTC daily.
- TCGdex (api.tcgdex.net) — Chinese (zh-tw / zh-cn) cards and Cardmarket EUR averages/trend.
- PokeAPI — Pokémon list and sprites.
- data/pull-rates.json — pull rates from Pullnomics (sourceUrl inside the file).
- Price history — daily TCGplayer snapshots this server records itself (store blobs `history:YYYY-MM-DD`).

## Deploy on Render (free tier)
1. Create a free Postgres at https://neon.tech (no card). Copy the **pooled** connection string
   (host contains `-pooler`, ends with `?sslmode=require`).
2. Push this repo to GitHub, then in Render: New → Blueprint → pick the repo (uses `render.yaml`).
3. Set the env vars Render asks for (all `sync: false`, never committed):
   | Var | Required | Purpose |
   |---|---|---|
   | `DATABASE_URL` | yes on Render | Postgres for users, sessions, alerts, price history, saved index. Without it the app uses local JSON files, which Render wipes on every restart/deploy. |
   | `INVITE_CODE` | yes | Sign-up invite code. In production, sign-up is disabled (503) if unset. Change it in the dashboard any time (restart applies it). |
   | `ALERTS_API_TOKEN` | yes for alerts job | Bearer token for `/api/admin/alert-hits`. Generate with `openssl rand -hex 32`. Endpoint returns 503 if unset. |
   | `NODE_ENV` | preset `production` | |
   | `HISTORY_DAYS` | preset `365` | Days of history loaded for charts. |
   | `DATA_DIR` | optional | Override the local data dir (JSON mode / scratch caches). |
4. Health check: `GET /healthz` (always 200 once listening; reports `storage`, `storeReady`, `indexReady`, `indexing`).

Storage: `store.js` uses Postgres when `DATABASE_URL` is set (tables `records` and `blobs`, created automatically),
otherwise JSON files in `data/` (`users.json`, `sessions.json`, `alerts.json` as id→object maps; `history/`; `cache/`).

Cold start: the server listens immediately, loads accounts, then loads the saved price index from the store (~0.5 s).
It only rebuilds when TCGCSV has a newer daily stamp (product lists are cached in the store, so a rebuild fetches
just the ~681 price files, a few seconds). Free Render services sleep after 15 min idle; the first request after
that takes about a minute while Render wakes the instance.

## Invite code
Production: `INVITE_CODE` env var only. Local dev (NODE_ENV not production, no env var): `data/config.json`
("inviteCode", auto-generated, gitignored); edit the file to change it.

## Sealed products
"📦 Sealed products" tab: booster boxes, ETBs, booster bundles, packs, collections, tins, blisters, decks, displays,
cases for every English + Japanese TCGCSV set (search, set picker, type filter, "only sets containing <Pokémon>").
Chinese sealed: no free price source exists, so none are shown. History = this server's own daily snapshots.
API: GET /api/sealed?q=&type=&langs=en,ja&cat=&groupId=&pokemon=&exclude=Case, GET /api/sealed/sets?langs=

## Price alerts
Two equivalent ways to get alert hits (neither sends email):

- HTTP (for a scheduled job outside Render):
  `curl -sS --retry 3 --max-time 180 -H "Authorization: Bearer $ALERTS_API_TOKEN" "https://<app>.onrender.com/api/admin/alert-hits?markNotified=1"`
  Without `markNotified=1` it's a dry run. 401 bad/missing token, 429 after 10 bad tokens/15 min per IP,
  503 token not configured or server still starting, 409 if a check is already running.
- CLI (same store via `DATABASE_URL`/`DATA_DIR`): `node check_alerts.js` (marks notified) or `node check_alerts.js --dry-run`.

Alert modes (chosen per alert in the UI; `POST /api/alerts` body `{kind, productId|tcgdexId, subType, mode, percent|target}`):
- `percent` (default, 75%): fires when the current price drops **below** `percent`% of the 30-day average.
  - Cardmarket-priced items (Chinese cards via TCGdex): average = Cardmarket `avg30` (falls back to `avg7`/`avg1`, labeled).
  - TCGplayer-priced items (EN/JP cards, packs, sealed): average = mean of the site's own recorded daily TCGplayer market
    price over the last 30 days. With fewer than 7 recorded days it still uses the days available and labels it
    (`site history, only N days (limited: fewer than 7)`, `averageLimited: true`; TCGplayer's market price is itself a
    recent-sales average, so it's the best available baseline). With no history, no trigger.
  - Site history only accumulates if storage persists (`DATABASE_URL`); on JSON storage Render wipes it on every restart.
- `target`: fires when the current price is at or below a fixed price (alerts created before modes existed are `target`).
`GET /api/alerts/quote?kind=&productId=&subType=&percent=` (or `source=tcgdex&tcgdexId=&lang=`) previews current, average,
averageBasis and triggerPrice for the form.

Output: JSON array of newly-hit alerts. Hits are marked notified and re-armed automatically once the
price goes back above the trigger. Each item: alertId, profile, email, kind (card|pack|sealed), productType, name, set,
language, variant, mode (percent|target), currentPrice, average, averageBasis (e.g. "Cardmarket 30-day avg",
"site history, 12 days"), averageDays, averageLimited, percentOfAverage (current as % of average), triggerPercent
(the alert's % setting, null for target mode), triggerPrice, target (= triggerPrice, kept for compatibility), currency,
priceField, link, image, pricesUpdated.

Scheduled daily at 4:30 PM ET by the owner; TCGCSV refreshes ~20:00 UTC (4 PM EDT / 3 PM EST), so that run sees same-day prices.

## Public URL note
`start.sh` uses `cloudflared --protocol http2`. A quick tunnel needs outbound access to Cloudflare's edge on port 7844 (UDP or TCP). If `tunnel.log` shows `dial tcp ...:7844: i/o timeout`, the network is blocking it and the trycloudflare URL will return 530. Use the Render deployment instead.
