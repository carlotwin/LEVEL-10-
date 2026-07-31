# Level 10 SMS Outreach Campaign — SANDBOX build

Twin Home Buyer · Data Management / AI & Automation

Automation for the **Level 10 SMS Outreach Campaign** (SOP owner: Jonathan
Rosanes). It executes the SOP as a fail-closed pipeline over REI BlackBook:
filter the `Level 10 Properties` tag, opt-in the phone, match the assigned
**ProfitDial number** from the source-of-truth spreadsheet, send an **approved,
controlled-rotation** template, verify it landed, and report **daily KPIs** with
a **per-template performance** table.

> **Texting is OFF by default.** The full app is built — including the live
> Playwright REI BlackBook adapter and Google Sheet ingestion — but it runs in
> SANDBOX mode (no carrier contacted) until *you* set `SANDBOX=false` +
> `ALLOW_LIVE_SEND=true` and install real templates. See **Safety** below.

---

## Quick start

```bash
npm install          # installs express, multer, xlsx
cp .env.example .env # safe defaults: SANDBOX=true, ALLOW_LIVE_SEND=false
npm start            # boots the dashboard
```

Open **http://localhost:3000**, then:

1. **Load Sandbox Scenarios** (built-in synthetic data — no PII), or upload a
   ProfitDial `.xlsx` and a contact list.
2. **Start** (Pause / Resume / Stop available).
3. Watch the **live results**, the **Daily KPI Report**, and the **per-template
   performance** table update in real time (via SSE).
4. **Export** results to XLSX or CSV.

Run the tests:

```bash
npm test             # pure SOP rules, template allocation, ProfitDial matcher
```

---

## First live check — watch it read 20 real leads (cannot text)

```bash
cp .env.example .env   # fill in REIBB_LOGIN_URL / REIBB_EMAIL / REIBB_PASSWORD
npm run watch:20       # visible browser, read-only, first 20 leads
```

Then open the dashboard, upload the Level 10 `.xlsx` (`With Contacts` tab) with
the limit set to **20**, and press **Start**. The bot logs in, filters the
`Level 10 Properties` tag, opens each contact, reads name/phone/tags, and matches
the assigned **ProfitDial** number from your sheet — reporting whether that
number is available in REI. Every row comes back **Needs Review** with
"No changes made, nothing sent." That is the expected result.

`npm run watch:20` forces `ALLOW_LIVE_SEND=false` into the environment *before*
the app boots, and `loadenv.js` never overwrites an existing variable — so this
entry point cannot send even if your `.env` says otherwise. Going live is a
separate, deliberate step (below).

Read the results table for: right 20 people, right phone, right ProfitDial,
"available in REI". If any of that is wrong, fix it before sending anything.

---

## Safety — the four independent gates (nothing sends by accident)

Real texting requires **all** of these, independently. Changing one variable can
never turn it on:

1. `SANDBOX=false` **and** a working live adapter (the skeleton refuses to run).
2. `ALLOW_LIVE_SEND=true` (checked at the moment of send).
3. **No placeholder template enabled** — placeholders are sandbox-only. ✅ Now
   satisfied: the six approved templates (`L10-1` … `L10-6`) are installed.
4. **Message integrity checksum** validated at startup and before every send.
   Pinned to the approved copy — edit any wording without re-running
   `node scripts/regen-checksum.js` and the app refuses to start or send.

Plus per-contact fail-closed gates: Level 10 tag, allowed state, suppression
scan (STOP / opt-out / do-not-contact / not-interested), single valid phone,
successful opt-in, exact ProfitDial match + availability + **digit-for-digit
readback**, valid merge fields, and send verification. Any uncertainty →
**Needs Review**, send nothing.

The **campaign duplicate ledger** is keyed on
`campaignBatch + REIContactID + normalizedPhone` and survives restarts,
re-uploads, and crashes, so no contact is texted twice for the same campaign.

---

## ProfitDial source of truth

The `With Contacts` tab of the Level 10 Master Spreadsheet. Confirmed headers:
`FIrst Name, Last Name, Owner, Full Address, Address, City, State, ZIP,
Primary Name, Primary Phone, Profit Dial`. There is **no Contact ID column**, so
matching uses **Full Address** (100% unique) then **Primary Phone**. Header
names are configured in `.env` (`PD_COL_*`) — no headers are hard-coded in logic.

Upload the real sheet at runtime; it is written to a git-ignored `data/`
directory and **never committed** (it contains real homeowner PII).

---

## ProfitDial from Google Sheets

Paste the sheet URL in the dashboard ("Ingest Google Sheet") or POST to
`/api/ingest/googlesheet`. Works when the sheet is shared *Anyone with the link
(Viewer)* or when you supply an OAuth token. A **private** sheet returns a clear
error (no columns are ever invented) — share it, enable the Google Drive
connector and upload an export, or pass a token.

## Going live later (you flip these — texting is off until then)

The live adapter and ingestion are **already built**. To actually text, all of
the following are required, and each defaults to off:

1. Verify `config/reibb.selectors.json` against your REI BlackBook account with
   `HEADLESS=false` and `SLOWMO_MS` set. Login / contacts / Chat tab / TinyMCE
   reply box / Send Text / tag chips are confirmed from the account; **opt-in and
   ProfitDial from-number selectors do not exist in this app** — they must be
   captured with `npx playwright codegen`. There is no way to switch those steps
   off (see **Mandatory SOP steps** below), so until they are captured every lead
   stops at `OPT_IN_REQUIRED` / `PROFITDIAL_NOT_VERIFIED` and nothing sends.
2. Set `REIBB_LOGIN_URL`, `REIBB_EMAIL`, `REIBB_PASSWORD` in `.env`.
3. ✅ Done — the six approved templates are installed (`placeholder: false`) and
   `EXPECTED_CHECKSUM` is pinned to them.
4. Set `SANDBOX=false` and `ALLOW_LIVE_SEND=true`. Start with a small
   `MAX_SENDS_PER_RUN`.

### Finding the lead in REI — phone only

The normalized 10-digit phone is the **primary and only** search key. The name is
never searched: a name search can surface a different homeowner. The same number
is retried in the renderings REI's box may require (`9166072808`,
`(916) 607-2808`, `916-607-2808`, `916.607.2808`) — still a phone search, not a
fallback to another key.

- **0 results** → `NO_CONTACT_FOUND_BY_PHONE`. The row is skipped. No contact is
  ever created.
- **1 result** → phone **and** name must match, with no conflicting address.
- **several results** → every candidate is compared; the first row is never taken
  by position. Exactly one confident match proceeds, same-name candidates are
  separated by property address, anything else is
  `MULTIPLE_CONTACTS_MANUAL_REVIEW`.

A page the automation could not drive is reported as `MANUAL_REVIEW_REQUIRED`,
never as `NO_CONTACT_FOUND_BY_PHONE` — "REI has nobody" and "the bot could not
search" are different facts and must not be conflated.

### Mandatory SOP steps (no override exists)

Three steps were configurable and are now hard-coded. Setting them to `false` in
`.env` is logged and ignored:

| | Enforced behaviour |
|---|---|
| `REQUIRE_LEVEL10_TAG` | The "Level 10 Properties" tag must be READ on the contact record. It is never written or added. Missing tag → `LEVEL_10_TAG_MISSING`, no send. |
| `REQUIRE_OPTIN` | The phone must be verifiably SMS-enabled. Clicking Opt In is not proof — the status is re-read afterwards. No control found → `OPT_IN_REQUIRED`; re-read still not enabled → `OPT_IN_FAILED`. Either way, no send. |
| `REQUIRE_PROFITDIAL` | The assigned sender must be selected and read back digit-for-digit. Missing assignment, missing selector, failed selection or unreadable read-back → `PROFITDIAL_NOT_VERIFIED`, no send. **The bot never sends from REI's default number.** |

### Verification is done twice

The Smart Contacts result row is only a **candidate** — its columns can be
truncated or stale. `CONTACT_VERIFIED` is set from the opened contact's own
detail page, where the phone, name, property address and Level 10 tag are read
again. An unreadable detail page is `MANUAL_REVIEW_REQUIRED`, never a pass.

### The production send gate

`sendText` is unreachable unless all six of these are the boolean `true`:

```
contactVerified · level10TagVerified · safetyReviewPassed
smsOptInVerified · profitDialVerified · approvedTemplateVerified
```

Anything `false`, missing, `undefined`, or merely truthy (`1`, `"true"`) blocks
the send. `test/sendGate.test.js` drives each gate false in turn against a spy
adapter and asserts `enterMessage` and `sendMessage` are never called.

### Read-only live verification (the next stage)

```bash
npm run verify:live -- "C:\path\to\Level 10 Properties with Contacts.xlsx"
```

Walks the first five rows and reports what could actually be read from the live
account: phone search, result parsing, contact opening, detail reads, the Opt In
control, and the ProfitDial sender selector. Sends nothing, opts in nobody,
selects no number, writes no tag. The sender read-back is deliberately skipped
because selecting a number modifies the record.

### Approved templates

`L10-1` … `L10-6`, all six enabled, rotated by controlled balanced allocation
(least-used first, no immediate repeats, deterministic per contact for audits).
Merge fields: `{{first_name}}` and `{{property_address}}`. The address comes from
the sheet's **Full Address** column (source of truth); the REI screen value is
only a fallback. A blank on either field is an `Invalid Merge Field` block — a
text is never sent with a hole in it. Every template ends with
"Reply STOP to opt out." (enforced by a test).

Miss any one and the app runs read-only/sandboxed or refuses — it never texts by
accident.

---

## Architecture

```
public/                     dashboard (upload, controls, live table, KPI, export)
server/
  index.js                  Express REST API + SSE
  config/env.js             the four hard safety gates
  automation/
    engine.js               orchestrator (Start/Pause/Resume/Stop, batch, resume)
    sop.js                  PURE decision rules (facts in -> decision out)
    message.js              locked templates, integrity, controlled allocation
    profitdial.js           fail-closed source-of-truth matcher
    constants.js            dispositions, phrases, regexes, KPI columns
  adapters/
    adapter-interface.js    shared contract (sandbox + live)
    sandbox.js              in-memory REI simulation (all scenarios)
    reibb.js                LIVE Playwright REI BlackBook adapter
    factory.js              mode-safe adapter construction
  data/
    store.js                resume-safe job state
    spreadsheet.js          CSV/XLSX import + export
    googleSheet.js          Google Sheet CSV ingestion (ProfitDial source)
    sentLedger.js           campaign duplicate ledger
    kpi.js                  daily + per-template KPI report
config/reibb.selectors.json externalized live selectors (verify per account)
config/sandbox/seed.js      synthetic contacts + ProfitDial rows (26 scenarios)
test/                       node:test suites for the pure core
```

Design principle (from the Revival AI reference): **separate gather-facts /
decide / act.** Adapters only gather facts and perform actions; every decision
lives in the pure, unit-tested `sop.js`. Each safety layer can only **add** a
block — never enable a send.
