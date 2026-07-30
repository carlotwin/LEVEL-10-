# Level 10 SMS Outreach Campaign — SANDBOX build

Twin Home Buyer · Data Management / AI & Automation

Automation for the **Level 10 SMS Outreach Campaign** (SOP owner: Jonathan
Rosanes). It executes the SOP as a fail-closed pipeline over REI BlackBook:
filter the `Level 10 Properties` tag, opt-in the phone, match the assigned
**ProfitDial number** from the source-of-truth spreadsheet, send an **approved,
controlled-rotation** template, verify it landed, and report **daily KPIs** with
a **per-template performance** table.

> **This is the SANDBOX build.** No real REI BlackBook, no carrier is ever
> contacted. The live sending path stays behind independent hard guards and the
> live adapter is a non-functional skeleton. See **Safety** below.

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

## Safety — the four independent gates (nothing sends by accident)

Real texting requires **all** of these, independently. Changing one variable can
never turn it on:

1. `SANDBOX=false` **and** a working live adapter (the skeleton refuses to run).
2. `ALLOW_LIVE_SEND=true` (checked at the moment of send).
3. **No placeholder template enabled** — placeholders are sandbox-only and block
   live sending until Cherry's approved copy is installed.
4. **Message integrity checksum** validated at startup and before every send.

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

## Going live later (not part of this build)

1. Implement `server/adapters/reibb.js` (Playwright) against the shared
   interface in `server/adapters/adapter-interface.js`. The engine needs no
   changes.
2. Install Cherry's 5–10 approved templates in `server/automation/message.js`
   (`placeholder: false`), run `node scripts/regen-checksum.js`, and pin the new
   `EXPECTED_CHECKSUM`.
3. Set `SANDBOX=false` and `ALLOW_LIVE_SEND=true`. Start with a small
   `MAX_SENDS_PER_RUN`.

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
    reibb.js                LIVE skeleton — throws LIVE_ADAPTER_NOT_IMPLEMENTED
    factory.js              mode-safe adapter construction
  data/
    store.js                resume-safe job state
    spreadsheet.js          CSV/XLSX import + export
    sentLedger.js           campaign duplicate ledger
    kpi.js                  daily + per-template KPI report
config/sandbox/seed.js      synthetic contacts + ProfitDial rows (26 scenarios)
test/                       node:test suites for the pure core
```

Design principle (from the Revival AI reference): **separate gather-facts /
decide / act.** Adapters only gather facts and perform actions; every decision
lives in the pure, unit-tested `sop.js`. Each safety layer can only **add** a
block — never enable a send.
