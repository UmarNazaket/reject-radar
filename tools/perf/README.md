# Performance check

`load.mjs` measures the p95 budget of spec section 9.2: notice search, topic dashboards, the watchlist and firm search must answer in 800 ms or less at the 95th percentile while the database is awake. It uses Node's built-in `fetch` and has no dependencies.

```
node tools/perf/load.mjs --base http://localhost:3000 --email <email> --password <password> [--requests 200] [--concurrency 4] [--firm-requests 50] [--watchlist-items 250]
```

- The account needs a verified email and a plan whose history window is the one you want to measure. Use `org.plan_override = 'pro'` (no history limit) for the worst case.
- It logs in, then runs every scenario in turn, with one warm-up request just before each (not measured: the first request after Neon sleeps is outside the budget):
  - notices with no filter, `origin=PK&commodity=100`, and `q=rice`;
  - dashboard `origin=PK`, and `origin=IN&commodity=200&destination=EU,UK`;
  - the watchlist, `GET /v1/watchlist`;
  - firm search `name=rice mills&country=PK`, and `name=al rahman`.
- Notice, dashboard and watchlist scenarios send `--requests` requests, `--concurrency` at a time.
- Before the watchlist scenario, the script brings the account's watchlist up to `--watchlist-items` topic items (default 250, the Business plan's size). It adds distinct topics (60 origin countries, each with or without one of 4 destinations, so up to 300) through `POST /v1/watchlist`, counts the items already there, and never removes any. If the plan's limit is lower, it stops there and says so. The account needs a verified email.
- Firm search is limited to 30 requests a minute per user, so it runs one request every 2.2 seconds, `--firm-requests` times each (default 50, about 110 seconds per scenario). Its warm-up runs just before the scenario, because it shares that window. If a firm request was made in the previous minute, the script waits 61 seconds first, and a warm-up that is still answered 429 waits 61 seconds and tries once more.
- Each request times out after 30 seconds, and a failed connection prints the underlying cause.
- It prints the count, p50, p95 and max per scenario, and exits 1 when any p95 is over 800 ms or any request did not answer 200.
- The access cookie lasts 15 minutes; the script logs in again before it ends.

Run it against a local API (`npx nx serve api`) and against staging, where the owner runs it with the staging account. Never run it against production data with a real customer's account.
