# Setup checklist: what is still needed

Everything below is access or information only the team can provide. Until each is done, the dashboard runs on clearly labeled **demo data** (or on whatever files are imported by hand). Run `npm run ppc:check` at any time to see what is still missing.

## 1. Google Ads (money: spend, clicks, keywords, cities, GCLIDs)

- [ ] **Developer token** with **Basic access**: Google Ads manager account → Tools → API Center → `GOOGLE_ADS_DEVELOPER_TOKEN`. *(New tokens are test-only until Google approves Basic access. Meanwhile use step 1b.)*
- [ ] **Google Cloud project** with the **Google Ads API** enabled.
- [ ] **OAuth client** (type "Desktop app") → `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`.
- [ ] **Refresh token**: run `npm run ppc:google-auth` signed in as a Google user who can see the ad account → `GOOGLE_ADS_REFRESH_TOKEN`.
- [ ] **Customer id** of the ad account → `GOOGLE_ADS_CUSTOMER_ID`; if a manager account owns it, the manager id → `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
- [ ] 1b (no developer token yet): install `ppc/integrations/google-ads-script.js` as a Google Ads Script, scheduled daily.

## 2. REI BlackBook (lead quality and deals)

Pick at least one:
- [ ] **Exports folder**: a scheduled or weekly REI contact export saved to one folder → `PPC_REI_EXPORT_DIR`. *(Recommended.)*
- [ ] **Google Sheet** of REI leads, shared "anyone with the link can view" → `PPC_REI_SHEET_ID`, `PPC_REI_SHEET_GID`.
- [ ] **Crawler** for the team's own REI login: `REI_CRAWLER_ENABLED=true`, `REIBB_EMAIL`, `REIBB_PASSWORD`; run `npm run ppc:rei-login` once and complete any code yourself.
  - [ ] `PPC_SECRET_KEY` (and `REI_PERSIST_SESSION=true`) if the sign-in should be kept between runs (encrypted).
  - [ ] Confirm the field labels on one REI contact page against `ppc/config/rei-crawler.selectors.json` → `detail.labels` (the `_verify` list names the ones not yet checked live): Lead Status, Lead Source, Motivation, Created, Appointment / Offer / Contract / Closed dates, Lost Reason, Revenue, Profit, GCLID, UTM fields.

In REI itself (this is what makes the numbers trustworthy):
- [ ] A **GCLID** custom field on every lead (and UTM fields), filled by the website forms.
- [ ] **Lead Source** set on every lead.
- [ ] **Revenue and profit** entered on every closed deal. *(Without profit, the system judges on cost per deal and says so; it never claims a profit it cannot see.)*
- [ ] Status names mapped in dashboard Settings → REI BlackBook → Lead statuses, if the account uses custom statuses.

## 3. Website and GA4 (landing pages, retargeting)

- [ ] **GA4 property id** → `GA4_PROPERTY_ID`.
- [ ] **Service account** with a JSON key saved outside the repo → `GA4_SERVICE_ACCOUNT_FILE`, added as **Viewer** in GA4 property access. *(Or allow Analytics in the Google sign-in from step 1.)*
- [ ] Website forms: a **hidden GCLID field** (from the `gclid` URL parameter) passed to REI; GA4 events `form_start` and `form_submit` / `generate_lead`.
- [ ] **Consent Mode** on the site (the retargeting audiences inherit it); optionally the share of visitors who accept ad cookies in Settings.
- [ ] `PPC_SITE_DOMAINS` if landing pages live on more than twinhomebuyer.com.

## 4. Calls

- [ ] Call log export (CallRail, ProfitDial or similar) imported on Data sources, and each **tracking number mapped** in Settings → Attribution (Google Ads or another channel).
- [ ] Call tracking set to capture the GCLID, if the provider supports it.

## 5. Running the agent

- [ ] A PC that stays on (the office PC is fine) with Node.js 20, this repo, and **Google Drive for desktop**.
- [ ] `PPC_BUNDLE_DIR` → a Drive folder, e.g. `G:\My Drive\Twin PPC`.
- [ ] `.env` filled in, `npm run ppc:check` all green, `npm run ppc:sync` once, then **PPC-AGENT.bat** (add it to Task Scheduler "At log on").
- [ ] Optional: `PPC_ALERT_WEBHOOK_URL` (Google Chat or Slack incoming webhook) for alerts.

## 6. The dashboard

- [ ] Open https://claude.ai/artifact/AJDaPjZVGZLRrpj73QyS8Z and **Share** it with the team: **Editor** for people who import data and change settings, **Contributor** for people who approve actions, **Viewer** for everyone else.
- [ ] Each editor who will sync from Drive: have the **Google Drive connector** added in claude.ai (Settings → Connectors) and allow it for the dashboard when asked.
- [ ] Review Settings: targets (cost per lead, per qualified lead, per appointment, per contract, per deal), the buy box cities and counties, seller situations.
- [ ] Load real data (a sync file from Drive, or files on Data sources). Real data replaces the demo completely; **Undo last change** goes back.

## What is already done

- Engine, dashboard, sync agent, Google Ads Script, crawler, demo data, documentation, unit and browser tests.
- The dashboard is published and works now on demo data; every connection above can be added without code changes.
