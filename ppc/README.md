# Twin PPC Decisions

One dashboard that answers: **which keyword + city is making money, and which is wasting money?**

It joins Google Ads, the website (GA4) and REI BlackBook, follows every lead from
**spend → lead → qualified lead → appointment → offer → contract → closed deal → profit**,
and gives each keyword + city one recommendation, **SCALE, WATCH, REDUCE or PAUSE**, with the reason:

> **PAUSE**: $1,420 spent, 31 clicks, 5 leads, 0 qualified leads, 0 contracts. Spending with no qualified leads.
>
> **SCALE**: $950 spent, 8 qualified leads, 3 appointments, 1 contract. Estimated acquisition cost within target.

Version 1 never changes Google Ads. **The system analyzes, recommends, and a person approves.**

- **Dashboard (claude.ai artifact):** https://claude.ai/artifact/AJDaPjZVGZLRrpj73QyS8Z
- **Setup still needed:** [SETUP_CHECKLIST.md](SETUP_CHECKLIST.md)

---

## How it fits together

```
 Google Ads API ─┐                          ┌─> data/ppc/dataset.json (no personal details)
 GA4 Data API ───┤                          │
 REI exports ────┼─> sync agent (this PC) ──┼─> twin-ppc-bundle.json in a Google Drive folder
 REI crawler ────┤   npm run ppc:agent      │            │
 landing pages ──┘                          └─> alerts (Google Chat / Slack)
                                                         │
        Google Ads Script (optional, no developer token) ─┤  Drive
        CSV / Excel exports dragged into the dashboard ───┤
                                                         ▼
                        Dashboard (claude.ai): recommendations, Action Queue, Data health
```

| Folder | What it is |
|---|---|
| `ppc/engine/` | The decision engine: importers, attribution, keyword + city spend, recommendations, search term waste, landing pages, retargeting, data health, alerts, the action queue. Plain JavaScript, no dependencies. The dashboard, the agent and the tests all run this same code. |
| `ppc/artifact/` | The dashboard. `src/` is the source; `npm run ppc:build` bundles it with the engine into one page. |
| `ppc/agent/` | The sync agent: Google Ads, GA4, REI (exports, Google Sheet, crawler), landing page scan, schedules, alerts. |
| `ppc/integrations/google-ads-script.js` | A Google Ads Script that exports the same data to Drive without a developer token. |
| `ppc/config/rei-crawler.selectors.json` | Where the crawler looks on REI pages. Edit this when REI changes its layout. |
| `ppc/demo/` | Demo data (made up, clearly labeled) and sample import files. |
| `ppc/test/` | Unit tests (`npm run ppc:test`) and browser tests (`npm run ppc:e2e`). |

## Install

Requires Node.js 18 or newer (20 recommended).

```bash
npm install                # the existing app's dependencies; the PPC system adds none
npx playwright install chromium   # only if you will use the REI crawler or run the browser tests
cp .env.example .env       # then fill in the PPC section (see below)
npm run ppc:check          # shows what is set up and what is missing
```

On Windows, double-click **PPC-SYNC.bat** (sync once), **PPC-AGENT.bat** (keep syncing on schedule) or **PPC-REI-LOGIN.bat** (sign in to REI yourself).

## Environment variables

All configuration is in `.env` (never committed; `.gitignore` covers it). `.env.example` lists every variable with a safe default. The PPC section:

| Variable | What it is for |
|---|---|
| `PPC_DATA_DIR` | Where the agent keeps its files. Default `data/ppc` (git-ignored). |
| `PPC_BUNDLE_DIR` | Folder for the dashboard sync file. Use a Google Drive for desktop folder, e.g. `G:\My Drive\Twin PPC`. |
| `PPC_TIMEZONE` | Time zone for schedules. Default `America/Los_Angeles`. |
| `PPC_SECRET_KEY` | 32-byte key that encrypts the saved REI sign-in. Only used with `REI_PERSIST_SESSION=true`. |
| `PPC_ALERT_WEBHOOK_URL` | Optional Google Chat or Slack incoming webhook for alerts. |
| `GOOGLE_ADS_*` | Developer token, OAuth client id/secret, refresh token, customer id, manager (login) customer id, API version. |
| `PPC_ADS_BACKFILL_DAYS` / `PPC_ADS_LOOKBACK_DAYS` | First sync pulls 90 days; later syncs re-pull the last 3 days (Google revises recent conversions). |
| `GA4_PROPERTY_ID`, `GA4_SERVICE_ACCOUNT_FILE` | GA4 property and a read-only service account key kept outside the repo. |
| `PPC_REI_EXPORT_DIR` | Folder where REI exports are saved (recommended). |
| `PPC_REI_SHEET_ID`, `PPC_REI_SHEET_GID` | A Google Sheet holding REI leads, shared "anyone with the link can view". |
| `REI_CRAWLER_ENABLED`, `REIBB_EMAIL`, `REIBB_PASSWORD`, `REI_*` | The crawler for your own REI account, and its speed limits. |
| `PPC_SITE_DOMAINS` | Only these domains are read by the landing page scan. |
| `PPC_SCHEDULE_*` | When each sync runs (cron). |

Secrets live only in `.env` on the PC that runs the agent. The dashboard never holds a password, token or key: it reaches Google Drive with each viewer's own claude.ai connection, and everything else it shows comes from the sync file.

## Google Ads setup

Two ways. Use the API for automatic syncs, or the Script if a developer token is not available yet.

**A. Google Ads API (read only)**
1. In Google Ads (a manager account is required): **Tools → API Center**. Copy the developer token into `GOOGLE_ADS_DEVELOPER_TOKEN`. Apply for **Basic access**; a new token only works on test accounts.
2. In Google Cloud console: create a project, enable **Google Ads API** (and **Google Analytics Data API** if you will use the same sign-in for GA4), then **Credentials → Create OAuth client → Desktop app**. Put the id and secret in `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET`.
3. Run `npm run ppc:google-auth`, sign in with a Google user that can see the ad account, and copy the printed `GOOGLE_ADS_REFRESH_TOKEN` into `.env`.
4. Set `GOOGLE_ADS_CUSTOMER_ID` (the account id, 123-456-7890). If a manager account owns the ad account, set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to the manager's id.
5. `npm run ppc:sync -- --only=google_ads`

What it pulls: campaigns, ad groups, keyword performance by day and device, search terms, spend by ad group and city (location of presence), every click's GCLID with its keyword and city (Google keeps these 90 days, one day per request), city names, and ad headlines. Every query is a read (`googleAds:searchStream`); nothing is ever changed.

**B. Google Ads Script (no developer token)**
Google Ads → Tools → Bulk actions → **Scripts** → new script → paste `ppc/integrations/google-ads-script.js` → Authorize → Run → schedule daily. It writes `twin-ppc-gads.json` to the Drive folder "Twin PPC". In the dashboard: **Data sources → Find sync files → Import**.

**C. CSV (always works)**
Download keyword, search term, location (user location) and click (GCLID) reports from Google Ads with the **Day** segment and drop them on **Data sources**. Import the same file twice and nothing doubles.

### How keyword + city spend is worked out
Google reports spend by keyword, and by ad group + city, but never by keyword + city. The engine fills that grid so that every keyword's total and every city's total match what Google reported, starting from where each keyword's clicks came from (the click report). Rows built this way are marked as estimated; totals are exact.

## GA4 setup

1. GA4 → **Admin → Property details**: copy the Property ID into `GA4_PROPERTY_ID`.
2. Google Cloud: create a **service account**, create a JSON key, save it outside the repo, and set `GA4_SERVICE_ACCOUNT_FILE` to its path.
3. GA4 → **Admin → Property access management**: add the service account's email as a **Viewer**.
4. On the website, send `form_start` and `form_submit` (or `generate_lead`) events; they power the "started the form" audience and the landing page numbers.
5. `npm run ppc:sync -- --only=ga4`

A GA4 CSV download (landing page report with Sessions, or page path report with Active users) also works on **Data sources**.

## REI BlackBook setup

In order of preference:

1. **Exports folder (recommended).** Export contacts from REI BlackBook (CSV or Excel) into one folder and set `PPC_REI_EXPORT_DIR`. Each sync imports the newest file if it is new.
2. **Google Sheet.** If the team keeps REI leads in a sheet, share it "anyone with the link can view" and set `PPC_REI_SHEET_ID` / `PPC_REI_SHEET_GID`. A private sheet can still be imported from the dashboard through your own Google Drive connection.
3. **Crawler (fallback).** For the team's own authorized REI account:
   - set `REI_CRAWLER_ENABLED=true` and `REIBB_EMAIL` / `REIBB_PASSWORD` (the same variables the Level 10 app uses);
   - run `npm run ppc:rei-login` (or **PPC-REI-LOGIN.bat**) once: a browser opens, you sign in and complete any verification code or CAPTCHA yourself;
   - to keep that sign-in between runs, set `REI_PERSIST_SESSION=true` and `PPC_SECRET_KEY`: the cookies are saved **encrypted** (AES-256-GCM) in `data/ppc/rei-session.enc`;
   - open one contact in REI and check the labels in `ppc/config/rei-crawler.selectors.json` (`detail.labels`) match yours; the ones still to confirm are listed under `_verify`.

   The crawler only reads what the account can already see, waits `REI_CRAWL_DELAY_MS` (at least 1 second, default 2.5) between pages, opens at most `REI_CRAWL_MAX_CONTACTS` contacts per run, and re-checks a contact only after `REI_RECRAWL_HOURS`. It **never bypasses MFA, CAPTCHA or any security control**: if REI asks for a code or shows a CAPTCHA, the run stops and says to run `npm run ppc:rei-login`.

   If REI changes its layout, the run stops that step, keeps the last good data, and **Data health** shows the exact step and selector that failed (for example `contact.detail · label "Lead Status"`). After `REI_FALLBACK_AFTER_FAILURES` failed runs (default 3) the crawler pauses itself and the agent relies on exports; after fixing the selector, run `npm run ppc:sync -- --only=rei --force-crawler`.

**Privacy.** Names, phone numbers, emails and property addresses are read only to match and de-duplicate leads. They are replaced by salted hashes before anything is stored; notes are never stored; free text kept (motivation, lost reason) is scrubbed of phones, emails and addresses. The dataset is checked for personal details before every save and the save is refused if any are found.

## CSV fallback

Every source has a file path, in the dashboard (**Data sources → Add files**, CSV / Excel / JSON) and from the command line:

```bash
npm run ppc:import -- "C:\Exports\rei-export.csv" "C:\Exports\keyword-report.csv"
```

The file type is recognised automatically: Google Ads reports (keyword, search terms, locations, clicks), REI exports, GA4 exports, call logs (CallRail, ProfitDial and similar), a landing page list (URL, H1, CTA), a sync file. Imports are idempotent: the same day for the same keyword replaces what was there.

## Database setup

There is no database server to install.

- **Dashboard:** the shared state lives in the claude.ai artifact's own database, created on first use:

  | Path | What | Who can change it |
  |---|---|---|
  | `config/dataset` | Which stored dataset is live (plus one version back, for Undo) | Editors |
  | `config/settings` | Targets, thresholds, buy box, seller situations, status mapping, tracking numbers | Editors |
  | `config/overrides` | A seller situation set by hand on a lead | Editors |
  | `actions/<id>` | Approve / reject / done decisions, who and when | Contributors and up |
  | `alerts/<id>` | Alerts marked as seen | Contributors and up |
  | `imports/<id>` | Import history | Editors (importing needs editor access) |

  The dataset itself is stored as a file (asset) of the artifact, and holds no personal details.
- **Agent:** plain JSON files in `data/ppc/` (git-ignored): `dataset.json`, `state.json`, optional `settings.json`, logs, and the encrypted REI session.

**Roles** follow the dashboard's Share menu: **Editor** = admin (imports, settings), **Contributor** = manager (approve / reject actions), **Viewer** = read only. Share the dashboard with the team from its Share menu.

## Running locally

```bash
npm run ppc:dashboard      # http://localhost:4173/?role=admin (also ?role=manager, ?role=viewer)
```

This serves the real dashboard page with a local stand-in for the claude.ai runtime (shared store, file storage, downloads, a fake Google Drive that serves `ppc/demo/csv` and `data/ppc/out`). It is for trying changes and for the browser tests; the team uses the claude.ai link.

Other commands:

| Command | What it does |
|---|---|
| `npm run ppc:check` | What is set up, what is missing (no network) |
| `npm run ppc:sync` | Sync everything once (`-- --only=google_ads,ga4,rei,pages`) |
| `npm run ppc:agent` | Keep syncing on the schedules |
| `npm run ppc:import -- <files>` | Import files |
| `npm run ppc:rei-login` | Sign in to REI yourself (MFA / CAPTCHA) |
| `npm run ppc:google-auth` | Get the Google refresh token |
| `npm run ppc:demo` | Regenerate the demo data |
| `npm run ppc:build` | Build the dashboard page into `ppc/artifact/dist/` |
| `npm run ppc:test` / `npm test` | Unit tests (engine, importers, agent) / all unit tests |
| `npm run ppc:e2e` | Browser tests (dashboard as admin / manager / viewer, REI crawler) |

## Deployment

- **Dashboard:** `npm run ppc:build`, then publish `ppc/artifact/dist/index.html` with `demo-dataset.json` next to it to the same artifact link (Claude does this; the declared capabilities are the shared database with `config` editable by editors only, viewer identity, file storage, downloads, the Google Drive connector's `search_files` and `download_file_content`, and comments).
- **Agent:** on the office PC (or any always-on machine with Google Drive for desktop): install, fill `.env`, run **PPC-AGENT.bat**. To start it with Windows, add PPC-AGENT.bat to Task Scheduler ("At log on"). On Linux/macOS: `npm run ppc:agent` under a service manager, or cron entries calling `npm run ppc:sync -- --only=...`.

## Scheduled jobs

| Job | Default (Pacific time) | Variable |
|---|---|---|
| Google Ads | 5:15 every day | `PPC_SCHEDULE_ADS` |
| GA4 | 5:25 every day | `PPC_SCHEDULE_GA4` |
| REI (exports, sheet, crawler) | every 4 hours at :05 | `PPC_SCHEDULE_REI` |
| Landing page scan | Monday 4:40 | `PPC_SCHEDULE_PAGES` |

After every job the agent rewrites the sync file, recomputes alerts and sends new ones to the webhook. Alerts: unusually high spend, keyword spending without leads or without qualified leads, REI crawler failure, Google Ads sync failure or stale data, a new Google Ads contract, a big week-over-week change in cost per lead or qualified rate. An editor who has allowed Google Drive sees "New sync file in Drive" in the dashboard and loads it with one click; the recommendations recompute immediately.

## Recommendation settings

Every rule is a setting (dashboard **Settings**; editors change them). Defaults:

| Setting | Default | Meaning |
|---|---|---|
| Target cost per lead / qualified lead / appointment / contract / closed deal | $650 / $1,500 / $2,500 / $10,000 / $15,000 | The costs a row is judged against |
| Judge after | $500 spent or 25 clicks | Before that a row is WATCH ("not enough data"). A contract or closed deal always counts. |
| Qualified leads before SCALE | 3 | Fewer: "promising, small sample" |
| Profit per $1 to SCALE | $1.50 | Used only when every closed deal in the row has profit recorded |
| REDUCE multiplier | 1.5× | Cost above target but within this: WATCH ("mixed"); beyond: REDUCE |
| PAUSE with no leads / with no qualified leads | $800 / $1,200 | Spend that earns a PAUSE |
| Outside the buy box | 80% of spend, from $100 | Cities marked outside the buy box earn a PAUSE |

How a row is judged, in order: tracking problems (no keyword or city) → WATCH; outside the buy box → PAUSE; recorded profit (only if every deal has profit) → SCALE / WATCH / REDUCE; not enough data → WATCH; the deepest funnel step with data (closed deal, contract, appointment, qualified lead) against its target; leads with none qualified; no leads at all. The system never calls a row profitable without profit data; it says "estimated acquisition cost" instead.

Attribution never guesses: a lead is tied to a keyword and city only by GCLID (high confidence), call tracking or UTM tags (medium), or lead-source text (low, keyword unknown). Everything else is "Unknown / Unmatched".

## Troubleshooting

| You see | Do this |
|---|---|
| "Google sign-in expired or was revoked" | `npm run ppc:google-auth`, replace `GOOGLE_ADS_REFRESH_TOKEN`. |
| "The developer token only has test access" | Apply for Basic access in API Center; meanwhile use the Google Ads Script or CSV. |
| "…cannot open 123-456-7890 … set GOOGLE_ADS_LOGIN_CUSTOMER_ID" | The account is under a manager account: set the manager id. |
| "GA4 sign-in has no access to this property" | Add the service account email as a Viewer in GA4. |
| "REI asked for a verification code (MFA)" / "showed a CAPTCHA" | Run `npm run ppc:rei-login` and complete it yourself. Set `REI_PERSIST_SESSION=true` + `PPC_SECRET_KEY` to keep the sign-in. |
| Data health: `contact.detail · label "Lead Status"` | REI renamed that field. Update `detail.labels` in `ppc/config/rei-crawler.selectors.json`; import an REI export meanwhile. |
| "Crawler paused after N failed runs" | Fix the selector, then `npm run ppc:sync -- --only=rei --force-crawler`. |
| "REI statuses not understood" | Map them in Settings → REI BlackBook → Lead statuses (download the settings for the agent too). |
| Many "Google Ads leads without a GCLID" | Add a hidden GCLID field to every website form and map it to an REI custom field; capture GCLID in call tracking. This is what makes keyword + city attribution exact. |
| The dashboard still shows DEMO DATA | Import real files or a sync file on Data sources. Real data replaces the demo completely. |
| Recommendations look too strict or too loose | Change the targets in Settings; every recommendation updates at once. |

Logs are in `data/ppc/logs/` (tokens, keys, passwords, emails and phone numbers are masked).
