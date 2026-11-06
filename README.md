# farmledge-app

Backend for Farmledge, a digital warehouse receipt platform for maize farmers
in Nigeria. See the System Design Document v2.3 for the full architecture.

**Current state: warehouse inventory and storage fees (shadow mode).** On top
of deposit intake (farmers, deposits, scale samples, photos, audits), the API
keeps an append-only stock ledger, records dispatches with delivery notes,
accrues storage fees and records payments, and serves the daily warehouse
reports. Stellar and lending are **provided for, not built**: each is a
switch or port with a working default (`docs/decisions.md`, provisions a–i;
`docs/architecture.md`). Nothing goes on chain and nothing is lent.

This repository holds two apps: the **API** (this directory) and the
**warehouse app** (`apps/warehouse/`), the offline-first PWA custodians use
at the counter. The monorepo layout (`apps/api`, `packages/shared`) follows
in a separate PR; until then the app keeps temporary copies of the API types.

## Running both apps locally

1. Set up and start the API as below (Postgres, `.env`, `npm run migrate`,
   then `npm run dev`, on http://localhost:3000).
2. Load the demo records and set the demo custodian's PIN:

   ```bash
   psql postgresql://farmledge:farmledge@localhost:5433/farmledge -f apps/warehouse/scripts/seed-dev.sql
   echo 482915 | npm run set-pin -- --phone=+2348000000001
   ```

3. Start the warehouse app on http://localhost:5173 (it proxies `/api` to
   the API):

   ```bash
   cd apps/warehouse && npm install && npm run dev
   ```

4. Sign in as 0800 000 0001 with PIN 482915. The seeded farmer is
   0803 123 4567.

`apps/warehouse/README.md` covers the offline build, installing on an
Android tablet, the sync queue and its tests.

## Prerequisites

| Tool           | Version                                                    |
| -------------- | ---------------------------------------------------------- |
| Node.js        | 24.x LTS (Vitest 5 does not support odd releases like 25)  |
| npm            | bundled with Node 24                                       |
| Docker Compose | v2, for local Postgres 18 (or any Postgres 18 you control) |

## Setup, step by step

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Create your `.env`**

   ```bash
   cp .env.example .env
   ```

   Every variable is required. The defaults point at the Docker database and
   set `FARMLEDGE_ENV=test`.

3. **Start Postgres and run migrations**

   ```bash
   docker compose up -d
   ```

   This starts Postgres 18 on **localhost:5433** (not 5432, so it won't clash
   with a local install). It also runs a one-shot `migrate` container. To
   check that the migrations succeeded:

   ```bash
   docker compose logs migrate
   ```

   To migrate from your machine instead:

   ```bash
   npm run migrate
   ```

4. **Run the checks**

   ```bash
   npm run build
   npm run lint
   npm test
   ```

   Tests need a Postgres server where they can create databases. They use
   `TEST_DATABASE_URL`, which defaults to the Docker one
   (`postgresql://farmledge:farmledge@localhost:5433/postgres`). Each suite
   creates its own `farmledge_test_*` database and drops it afterwards.

5. **Start the API**

   ```bash
   npm run dev
   curl localhost:3000/health
   ```

   Expected response:

   ```json
   { "status": "ok", "environment": "test", "database": "ok" }
   ```

## Scripts

| Script                            | What it does                                                            |
| --------------------------------- | ----------------------------------------------------------------------- |
| `npm run dev`                     | Runs the API with reload and pretty logs                                |
| `npm run build`                   | Compiles `src/` to `dist/`                                              |
| `npm start`                       | Runs the compiled API                                                   |
| `npm run migrate`                 | Applies pending migrations (after the environment check)                |
| `npm run migrate:down`            | Rolls back the last migration (refused on `live` databases)             |
| `npm run accrue-fees`             | Accrues storage fees through yesterday (`-- --through=DATE`)            |
| `npm run create-admin`            | Creates a Farmledge admin (`-- --name= --phone= --reason= --operator=`) |
| `npm run set-pin`                 | Sets a custodian's sign-in PIN (`-- --phone=`; PIN read from stdin)     |
| `npm run lint` / `typecheck`      | ESLint (strict, type-aware) / `tsc --noEmit` including tests            |
| `npm run format` / `format:check` | Prettier                                                                |
| `npm test`                        | Vitest, against real throwaway Postgres databases                       |

## Environment separation (test vs live)

Live data and test data must never mix. Three layers enforce this:

1. **Database identity.** The first migration stamps the database with
   `FARMLEDGE_ENV` in a one-row `db_environment` table. A trigger stops that
   row from ever being changed or deleted.
2. **Startup guard.** The API and `npm run migrate` both compare
   `FARMLEDGE_ENV` with the database's stamp. They refuse to run if the two
   differ or if the database has no stamp.
3. **Every row.** Every table has
   `environment NOT NULL DEFAULT current_db_environment()`. A trigger rejects
   any insert or update that names a different environment, even from
   hand-written SQL.

Test fixtures live in `test/fixtures/` and refuse to load into anything but a
`test` database. There is no seed script.

To set up a live database, create an empty database, set `FARMLEDGE_ENV=live`
and its `DATABASE_URL`, then run `npm run migrate`.

## Configuration

Config is validated with zod at startup (`src/config/`). If any variable is
missing or invalid, the process lists every problem and exits. See
`.env.example` for the full list:

- environment name and database URL
- port, log level and shutdown timeout
- maize bag size (100 kg) and moisture limits, in basis points (1350 = 13.50%).
  The API itself uses percentages (13.5); see `docs/decisions.md` D1
- grading scheme and grade codes (`provisional`: 1, 2, 3); see
  `docs/decisions.md` D11
- shrinkage tolerance at dispatch (2%, placeholder)
- business time zone (`Africa/Lagos`) for reports and fee accrual
- switches for open decisions, each with a working default:
  `LENDING_ENABLED`, `CHAIN_ENABLED`, `CONFIRMATION_MODE`, `WEIGHT_MODE`,
  `RELEASE_AUTHORITY`,
  `KEY_SERVICE` (+ `KEY_SERVICE_LOCAL_SECRET`, refused in live while it is the
  example value), `SMS_GATEWAY`, `PRICING_PROVIDER`
- intake limits: bag counts above 300 need confirmation and above 1000 are
  rejected; offline captures older than 48 hours are flagged for review and
  older than 7 days are rejected (`docs/decisions.md` D2, D3)
- photo storage directory and size limit (5 MB)
- staff sign-in: `AUTH_REQUIRED` (refused as `false` in live) and how long a
  sign-in lasts, `STAFF_SESSION_TTL_HOURS` (`docs/decisions.md` D41)
- placeholders, not yet used: grace period, sale window and fee rates

## Schema

The migrations are in `migrations/`, as plain SQL with up and down sections.

| Table                            | Purpose                                                               |
| -------------------------------- | --------------------------------------------------------------------- |
| `db_environment`                 | The database's fixed environment identity                             |
| `warehouses`                     | Registered warehouses                                                 |
| `custodians`                     | Warehouse staff, each tied to one warehouse                           |
| `warehouse_owners`               | Warehouse owners: set fees and tolerance, late cancels, reversals     |
| `platform_admins`                | Farmledge staff who set up warehouse owners (created from the CLI)    |
| `role_assignments`               | Every admin and owner assignment: who, by whom, when and why          |
| `verifiers`                      | Farmledge verification agents                                         |
| `verifier_warehouses`            | Where each verifier may attest (D44); removed, never deleted          |
| `farmers`                        | Name, phone (E.164), data consent date, optional lookup consent       |
| `farmer_warehouses`              | Which warehouses a farmer is registered at, and by which custodian    |
| `deposits`                       | One row per intake; client-generated unique `deposit_id`              |
| `scale_samples`                  | Scale readings: spot checks, or the weight of scale-weighed deposits  |
| `deposit_photos`                 | Intake photo references (at most 3 per deposit); bytes in PhotoStore  |
| `deposit_weights`                | View: the weight each deposit's receipt is minted with                |
| `receipts`                       | Off-chain receipt mirror; chain fields nullable for now               |
| `audits`, `audit_lines`          | Physical stock counts against recorded stock, with generated variance |
| `events_archive`                 | Raw contract events (unused for now)                                  |
| `notifications`                  | Outbound SMS log                                                      |
| `stock_movements`                | The stock ledger: append-only, signed bag and kg movements            |
| `stock_balances`                 | View: balances per warehouse, farmer, commodity, scheme and grade     |
| `stock_adjustments`              | Corrections with reason, recorder and authorising verifier            |
| `dispatches`                     | Stock leaving: bags, book kg, exit weight, shrinkage, delivery note   |
| `farmer_confirmations`           | Farmer approvals (tablet now; pending/external ref for two-way SMS)   |
| `document_sequences`             | Per-warehouse delivery note counters                                  |
| `storage_fee_schedules`          | Fee rates per warehouse with effective dates (insert-only)            |
| `storage_fee_accruals`           | Daily charges, corrections and minimum-period top-ups (append-only)   |
| `fee_accrual_runs`               | One row per accrual run                                               |
| `fee_payments`                   | Payments recorded (no money moves)                                    |
| `warehouse_platform_fee_terms`   | What Farmledge charges a warehouse, with effective dates              |
| `manual_prices`                  | Prices per tonne entered by hand, for reports                         |
| `chain_intents`                  | What would have gone on chain while `CHAIN_ENABLED=false`             |
| `key_signature_log`              | Every signature the KeyService makes                                  |
| `deposit_cancellations`          | Who cancelled a deposit, why, and the fees reversed                   |
| `fee_payment_reversals`          | Payment reversals: who, why, when (payment kept)                      |
| `warehouse_shrinkage_tolerances` | Per-warehouse shrinkage threshold history                             |

Notes on `deposits`:

- `estimated_weight_kg` is a generated column, `bag_count × bag_size_kg`, so
  it cannot drift from the bag count.
- `bag_size_kg` is recorded on each row so the estimate stays auditable if the
  configured bag size changes.
- `moisture_bps` is in basis points of a percent (1250 = 12.50%), the unit the
  receipt contract stores.
- The weight to mint comes from the `deposit_weights` view. Bag-estimate
  deposits use the estimate. Scale deposits use the sum of their
  `scale_samples`, rounded down to whole kg, and have no weight (cannot be
  minted) until every bag has been weighed. Samples on bag-estimate deposits
  are spot checks and never change their weight. Samples are rejected when
  they would cover more bags than the deposit has.
- The custodian must belong to the deposit's warehouse, and the farmer must
  be registered there; both are enforced by composite foreign keys.

## API

All bodies are JSON with `snake_case` fields, except photo uploads. Errors
always look like this:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Deposit is invalid",
    "details": [
      { "code": "moisture_out_of_range", "field": "moisture_pct", "message": "Moisture must be…" }
    ]
  },
  "requestId": "…"
}
```

`details` lists **every** problem at once, each with a stable `code`, the
`field` it concerns and a message fit to show a custodian.

**Staff sign-in.** Custodians sign in with `POST /auth/sessions`
(`phone`, `pin`) and send `Authorization: Bearer <token>`. With
`AUTH_REQUIRED=true` (always in live) the tablet's intake, dispatch,
farmer-balance, stock-audit and daily-summary routes need it (D57),
and the custodian a body names must be the signed-in one (403
`actor_mismatch` otherwise). Verifiers, owners and admins are still named in
the request and trusted. Rules and reasons: `docs/decisions.md` D41. Set a
PIN with `echo 482915 | npm run set-pin -- --phone=+2348000000001`.

| Method and path                                                                          | Purpose                                               |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `GET /health`                                                                            | Liveness and database environment check               |
| `POST /auth/sessions`                                                                    | Custodian sign-in: token, warehouse, verifier roster  |
| `GET /auth/sessions/current`, `DELETE`                                                   | The session with a fresh roster / sign out            |
| `POST /farmers`                                                                          | Register a farmer at a warehouse                      |
| `GET /farmers?phone=`                                                                    | Find a farmer by phone                                |
| `GET /warehouses/:id/farmers`                                                            | The warehouse's farmers for the tablet cache (D43)    |
| `POST /deposits`                                                                         | Record a deposit (idempotent on `deposit_id`)         |
| `POST /deposits/batch`                                                                   | Record up to 100 offline captures, each independently |
| `GET /deposits/:depositId`                                                               | One deposit                                           |
| `GET /deposits?warehouse=&farmer=&status=&needs_review=&from=&to=`                       | List deposits, newest first, paginated                |
| `POST /deposits/:depositId/scale-samples`                                                | Record a scale reading                                |
| `GET /warehouses/:id/scale-summary`                                                      | Measured vs assumed kg per bag                        |
| `POST /deposits/:depositId/photos?uploaded_by=`                                          | Attach a photo (raw image body)                       |
| `GET /deposits/:depositId/photos`                                                        | List a deposit's photos                               |
| `GET /deposits/:depositId/photos/:photoId`                                               | The image bytes                                       |
| `POST /audits`                                                                           | Start a stock audit                                   |
| `POST /audits/:auditId/lines`                                                            | Record one commodity and grade counted                |
| `POST /audits/:auditId/complete`                                                         | Close an audit to further lines                       |
| `GET /audits/:auditId/report`                                                            | Recorded vs counted, with differences                 |
| `GET /warehouses/:id/stock`                                                              | Current stock by commodity and grade, valued          |
| `GET /farmers/:id/balance?warehouse=`                                                    | A farmer's balances, free and held on-chain           |
| `GET /farmers/:id/lots?warehouse=&commodity=&grade=`                                     | A farmer's lots, oldest first, with state (D54)       |
| `GET /ledger?warehouse=&farmer=&commodity=&kind=&from=&to=`                              | Ledger history, newest first, paginated               |
| `POST /adjustments`                                                                      | Correct stock (reason, recorder, authoriser)          |
| `POST /deposits/:depositId/cancel`                                                       | Cancel a deposit recorded by mistake; reverses fees   |
| `POST /dispatches`                                                                       | Stock leaving (idempotent on `dispatch_id`)           |
| `POST /dispatches/plan`                                                                  | The lots a dispatch would draw; records nothing       |
| `POST /warehouses/:id/dispatch-blocked`                                                  | A dispatch the tablet blocked offline (D54)           |
| `GET /warehouses/:id/dispatch-blocked?from=&to=`                                         | How many, from every tablet there (D57)               |
| `GET /dispatches?warehouse=&farmer=&needs_review=&from=&to=`                             | Dispatches, newest first (flagged shrinkage)          |
| `GET /dispatches/:dispatchId`                                                            | One dispatch                                          |
| `GET /dispatches/:dispatchId/delivery-note`                                              | Printable delivery note (JSON)                        |
| `POST /warehouses/:id/shrinkage-tolerance`, `GET`                                        | Shrinkage review threshold, per commodity or default  |
| `POST /admin/warehouse-owners`                                                           | Create or promote a warehouse owner (admin only)      |
| `POST /warehouses/:id/storage-fee-schedules`                                             | Add a storage fee schedule                            |
| `GET /warehouses/:id/storage-fee-schedules`                                              | List schedules                                        |
| `GET /farmers/:id/statement?warehouse=&from=&to=`                                        | Deposits, dispatches, fees, payments, outstanding     |
| `POST /farmers/:id/statement/notify`                                                     | Text the farmer what they owe                         |
| `POST /fee-payments`                                                                     | Record a payment (no money moves)                     |
| `POST /fee-payments/:paymentId/reverse`                                                  | Reverse a payment recorded in error (owner only)      |
| `GET /warehouses/:id/reports/daily?date=`                                                | Intake and dispatch for one day                       |
| `GET /warehouses/:id/reports/outstanding-fees`                                           | Farmers who owe storage fees                          |
| `GET /warehouses/:id/reports/audits?from=&to=`                                           | Audits with their variance                            |
| `GET /warehouses/:id/reports/shrinkage?from=&to=`                                        | Stock in vs out; weighed loss at exit                 |
| `GET /warehouses/:id/reports/platform-fees?from=&to=`                                    | What the warehouse owes Farmledge                     |
| `POST /warehouses/:id/platform-fee-terms`, `GET`                                         | Platform fee model per warehouse                      |
| `POST /prices`, `GET /prices?commodity=`                                                 | Manual prices per tonne                               |
| `GET /features`                                                                          | Current switches and intake rules, for the tablet     |
| `POST /lending/locks`, `…/unlock`, `…/recovery`, `POST /lending/recoveries/:id/complete` | Lending stubs: always 501                             |

### Farmers

`POST /farmers` with `full_name`, `phone`, `warehouse_id`,
`registered_by` (a custodian of that warehouse) and `consent`, plus an
optional `lookup_consent`.

- `consent` is consent to hold the farmer's data (NDPA). Without it the
  request is rejected with `consent_required`. `lookup_consent` (lenders may
  look the farmer up) is separate and optional.
- Phones may be written `0803 123 4567`, `803…`, `234803…` or `+234 803…`, and
  are stored as `+2348031234567`. Only Nigerian mobile ranges (070, 071, 080,
  081, 090, 091) are accepted.
- One person has one record, keyed by phone. Registering a known phone at a
  **new** warehouse links the existing farmer (`farmer_created: false`).
  Registering it again at the **same** warehouse is a 409
  `farmer_already_registered`.

`GET /farmers?phone=` normalises the phone the same way and returns
`{ "items": [...] }` (0 or 1 farmer, with their warehouses).

`GET /warehouses/:id/farmers?limit=&cursor=` is the tablet's offline lookup
cache: the signed-in custodian's own warehouse only, `id`, `phone` and
`full_name` only, always behind a session (`docs/decisions.md` D43).

### Deposits

`POST /deposits` fields:

| Field                                                      | Rule                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `deposit_id`                                               | UUID generated on the tablet                                                                                                                |
| `farmer_id`, `warehouse_id`, `custodian_id`, `verifier_id` | Must exist. Warehouse active; custodian and verifier not suspended; custodian works there; verifier assigned there; farmer registered there |
| `commodity`                                                | `MAIZE_WHITE` or `MAIZE_YELLOW`                                                                                                             |
| `grade`                                                    | A code of `GRADE_VALUES` (`"1"`, `"2"`, `"3"`); a whole number is also accepted. Returned as a string with `grading_scheme`                 |
| `moisture_pct`                                             | Percentage with **at most one decimal** (`12.5`), within the configured limits (0–13.5). Stored as basis points                             |
| `bag_count`                                                | Whole number from 1 to `BAG_COUNT_MAX` (1000). Above `BAG_COUNT_CONFIRM_ABOVE` (300) needs `confirm_bag_count: true`                        |
| `confirm_bag_count`                                        | Optional boolean; confirms a large bag count                                                                                                |
| `notes`                                                    | Optional, at most 500 characters                                                                                                            |
| `captured_at`                                              | Optional ISO 8601 with offset; defaults to now. At most 5 minutes ahead. Over 48 hours old: flagged; over 7 days: rejected                  |

The deposit is stored with `weight_source: "bag_estimate"`,
`weight_kg = bag_count × bag size` and `status: "recorded"`. Responses give
moisture as `moisture_pct`. They also include `bag_count_confirmed`, and
`needs_review` with `review_reasons` (`late_capture` for an offline capture
more than 48 hours old). The rules and their reasons are in
`docs/decisions.md`.

**Idempotency.** `deposit_id` is the idempotency key, shared by the single
and batch endpoints:

- first submission: `201`, `"duplicate": false`
- identical repeat: `200`, `"duplicate": true`, with the original deposit
- same `deposit_id`, different content: `409 deposit_id_conflict`, with
  `details.differing_fields`. `captured_at` and `confirm_bag_count` are not
  compared.

This holds under concurrent submissions: exactly one insert wins.

**Batch.** `POST /deposits/batch` with `{ "items": [...] }` (1–100 items,
each a deposit with **required** `captured_at`). Every item is processed on
its own, and the response is `200` with one result per item:

```json
{
  "summary": { "created": 1, "duplicate": 0, "rejected": 1 },
  "results": [
    { "index": 0, "deposit_id": "…", "status": "created", "deposit": { … } },
    { "index": 1, "deposit_id": "…", "status": "rejected",
      "error": { "code": "validation_failed", "message": "…", "details": [ … ] } }
  ]
}
```

Retrying a whole batch is safe: items already stored come back as
`duplicate`. If the server fails partway (a 5xx), items processed before
the failure are kept, and a retry reports them as duplicates.

**Listing.** `GET /deposits` takes optional filters `warehouse`, `farmer`,
`status`, `needs_review` (`true`/`false`), and `from`/`to` (business dates
of intake, inclusive), plus `limit` (default 50, max 200). Results are newest first. Pass
`next_cursor` back as `cursor` for the next page; it is `null` on the last
page.

`GET /deposits/:depositId/slip` returns the counter slip's QR payload
(`proofs[].qr_payload`, the leaf and its salt) and `printable`, the names
the slip prints, so any tablet at the warehouse can reprint it (D46). Find
a deposit by the number on a slip with `GET /deposits?deposit_no=`. With a
staff session these reads cover the session's own warehouse only. **Its encoding is
provisional** until farmledge-protocol#5 specifies it (`docs/decisions.md`
D45).

### Scale samples

`POST /deposits/:depositId/scale-samples` with `bags_weighed`, `total_kg`
(up to 2 decimals), `recorded_by` (a custodian of the deposit's warehouse)
and an optional `recorded_at`. Samples are stored separately and **never
change a bag-estimate deposit's `weight_kg`**. Samples covering more bags
than the deposit has are a 409 `scale_samples_exceed_bags`.

Send a tablet-generated `sample_id` (UUID) so retries are safe: an identical
repeat is `200` with `"duplicate": true`, different content under the same ID
is a 409 `sample_id_conflict` (`docs/decisions.md` D42).

`GET /warehouses/:id/scale-summary?commodity=&from=&to=` returns
`sample_count`, `bags_weighed`, `total_kg`, `avg_kg_per_bag`,
`nominal_kg_per_bag` (the bag size assumed at intake),
`variance_kg_per_bag` (average minus nominal; negative means bags are lighter
than assumed) and `variance_pct`.

### Photos

`POST /deposits/:depositId/photos?uploaded_by=<custodian id>` with the image
as the raw body and `Content-Type: image/jpeg`, `image/png` or `image/webp`.
The file's bytes must match that type (`415` otherwise). Uploads above
`PHOTO_MAX_BYTES` get a `413`.

- A deposit holds at most 3 photos; a 4th is a 409 `photo_limit_reached`.
- Re-uploading the same image returns the existing photo (`200`,
  `"duplicate": true`) and doesn't use a slot.
- Requiring at least one photo belongs to a later step, before a deposit is
  submitted for minting. `photo_count` is on every deposit.

Photos go through the `PhotoStore` interface (`src/storage/`). The current
implementation writes to local disk under `PHOTO_STORAGE_DIR/<environment>/`.

### Audits

1. `POST /audits` with `warehouse_id`, `counted_by` and `witnessed_by` (the
   names of who physically counted and who watched; the witness can't be a
   custodian of the warehouse), `entered_by` (the custodian entering the
   figures; with a session, the signed-in one) and/or `conducted_by` (a
   verifier), and optional `started_at` and `notes` (D57).
2. `POST /audits/:id/lines` with `commodity`, `grade`, `counted_bags` and
   optional `counted_kg` and `notes`. The system snapshots its recorded stock
   for that commodity and grade at that moment: all deposits not rejected or
   cancelled, net of dispatches and adjustments (it reads the stock ledger).
   When `counted_kg` is omitted, it is taken as
   `counted_bags × bag size` (`counted_kg_estimated: true`). Each commodity
   and grade can be counted once per audit.
3. `POST /audits/:id/complete` closes the audit.
4. `GET /audits/:id/report` returns, per line and in total, recorded vs
   counted bags and kg, `difference_*` (counted − recorded) and
   `difference_*_pct` (difference ÷ recorded × 100, rounded half away from
   zero to 2 dp, `null` when nothing was recorded). `uncounted` lists stock
   the system records for combinations nobody counted.

### Stock ledger

Every change to stock is a row in an append-only ledger: `deposit_in`,
`deposit_void` (a deposit rejected or cancelled), `dispatch_out` and
`adjustment`. Balances are always sums over it, kept per warehouse, farmer,
commodity, grading scheme and grade. A balance can never go negative,
whatever writes to it. A deposit captured offline lands on its capture time,
so the order things arrive in never changes a balance (`docs/decisions.md`
D12).

- `GET /warehouses/:id/stock` returns `lines` per commodity and grade
  (`bags`, `kg`, `farmer_count`, `price_per_tonne_ngn`, `value_ngn` from the
  manual price, or `null`), and `totals`.
- `GET /farmers/:id/balance?warehouse=` returns the farmer's non-zero
  balances.
- `GET /ledger` filters by `warehouse`, `farmer`, `commodity`, `kind`, and
  `from`/`to` (business dates, `YYYY-MM-DD`, inclusive). Newest first by
  `occurred_at`, with `limit` and `cursor` as for `/deposits`.
- `POST /adjustments` with `adjustment_id` (UUID; idempotency key),
  `warehouse_id`, `farmer_id`, `commodity`, `grade`, `bags_delta`,
  `kg_delta` (either may be negative, not both zero), `reason_code`
  (`audit_correction`, `data_entry_error`, `spoilage`, `other`), `notes`
  (required), `recorded_by` (custodian of the warehouse) and
  `authorised_by` (verifier). Taking a balance below zero is a 409
  `insufficient_balance`.

### Dispatch

`POST /dispatches` with `dispatch_id` (UUID from the tablet; idempotency
key), `warehouse_id`, `farmer_id`, `custodian_id`, `commodity`, `grade`,
`bag_count`, `exit_weight_kg` or else `not_weighed_reason` (why it was not
weighed), optional `buyer_name` (free text) and `notes`, and
`farmer_confirmed: true` (the farmer approved on the tablet).

- More bags than the farmer's balance of that grade: 409
  `insufficient_balance` with `available_bags` and `available_kg`. Nothing
  is recorded.
- `book_kg` is the bags' share of the balance's kg; the last bags take the
  exact remainder. With an exit weight, `shrinkage_kg` and `shrinkage_pct`
  show the loss.
- **Shrinkage never blocks an exit.** Each dispatch stores its variance and
  the tolerance it was judged against (the warehouse's own for the
  commodity, else the warehouse's default, both set by the owner with
  `POST /warehouses/:id/shrinkage-tolerance` and a reason, else the 2%
  configured default). Above it the dispatch is flagged `needs_review` with
  `shrinkage_above_threshold`; `GET /dispatches?needs_review=true` lists
  them.
- The response includes `delivery_note_no` (`KN-DAWANAU-DN-000001`,
  sequential per warehouse) and the farmer `confirmation`.
  `GET /dispatches/:id/delivery-note` returns everything a printed note
  needs, including the environment.
- The farmer gets an SMS, and an exit intent is recorded for the chain
  (`chain_tx_hash` stays `null`).

### Storage fees

What a warehouse charges its farmers (`docs/decisions.md` D14–D16):

- `POST /warehouses/:id/storage-fee-schedules` with optional `commodity`
  (omit for the warehouse default), `basis` (`per_bag` or `per_tonne`),
  `period` (`day`, `week`, `month`), `rate_ngn`, optional `minimum_days`,
  `effective_from`, `reason` and `set_by`: the **warehouse owner** (a
  custodian gets 403 `owner_required`). A schedule applies until the next
  one; a commodity without its own schedule uses the default. It must start
  after the last accrued day (409 `schedule_would_reprice`), so past
  charges are never recalculated.
- `npm run accrue-fees` (daily, from cron) charges each balance for each
  day on its end-of-day stock. Monthly rates are spread over the days of
  the month. Stock captured offline that arrives late is charged by
  `correction` rows; early exits before `minimum_days` get a
  `minimum_topup`. Re-running adds nothing.
- `GET /farmers/:id/statement?warehouse=&from=&to=` (dates default to the
  farmer's first movement and today) returns `stock` (`opening`,
  `movements`, `closing`) and `fees` (`opening_outstanding_ngn`,
  `accrued_ngn`, `paid_ngn`, `closing_outstanding_ngn`, `accrued_by_kind`,
  `payments`), plus `accrued_through`.
- `POST /farmers/:id/statement/notify` with `warehouse_id` and
  `requested_by` texts the farmer the amount outstanding.
- `POST /fee-payments` with `warehouse_id`, `farmer_id`, `amount_ngn`,
  `reference` (unique per warehouse; idempotency key), `paid_on`, `method`
  (`cash`, `bank_transfer`, `pos`, `other`), optional `notes` and
  `recorded_by`. Recording only: no money moves. More than is owed is a 409
  `payment_exceeds_outstanding`.
- `POST /fee-payments/:id/reverse` with `reversed_by` (the warehouse owner)
  and `reason` reverses a payment recorded in error. The payment stays;
  statements show the reversal beside it and count it from its date.

### Cancelling a deposit

`POST /deposits/:id/cancel` with `cancelled_by` and `reason`, for deposits
recorded by mistake. Grain that left is a dispatch, not a cancellation (409
`deposit_stock_dispatched`).

- Within 24 hours of recording (`DEPOSIT_CANCEL_WINDOW_HOURS`), a custodian
  of the warehouse or its owner may cancel; after that, only the owner (403
  `owner_required`).
- The stock is reversed at the deposit's intake time, and every storage fee
  it accrued is reversed by contra entries linked to the cancellation (its
  reason and authoriser). The response gives `fees_reversed_ngn`.

### Reports

Under `/warehouses/:id/reports/`. Dates are business dates in
`BUSINESS_TIMEZONE`; `from`/`to` default to the 30 days ending today.

| Report                    | Returns                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `daily?date=`             | Intake and dispatch per commodity and grade for one day, adjustments and voided deposits |
| `outstanding-fees`        | Each farmer's accrued, paid and outstanding fees, largest first, with totals             |
| `audits?from=&to=`        | Each audit started in the period with its total variance                                 |
| `shrinkage?from=&to=`     | Per commodity: bags and kg in vs out, weighed shrinkage, dispatches over tolerance       |
| `platform-fees?from=&to=` | What the warehouse owes Farmledge under its terms (`none` by default)                    |

Current stock by commodity and grade is `GET /warehouses/:id/stock`.

### Switches for open decisions

`GET /features` returns the current switches. Each open decision is a
config value or port with a working default; all are listed with what
changes when they are decided in `docs/decisions.md` ("Provisions a–i"):

- **Lending** (`LENDING_ENABLED=false`): `/lending/*` routes answer 501
  `feature_disabled`; when enabled they validate and answer 501
  `not_implemented`.
- **Chain** (`CHAIN_ENABLED=false`): intents go to `chain_intents`; `true`
  stops the server at startup.
- **Keys** (`KEY_SERVICE=local_dev`): derived Ed25519 keys, signatures
  logged; `kms` stops the server at startup.
- **SMS** (`SMS_GATEWAY=mock`): messages are logged.
- **Confirmation** (`CONFIRMATION_MODE=tablet_only`): `sms_two_way` makes
  dispatch answer 501.
- **Weight** (`WEIGHT_MODE=bag_estimate`): `scale_required` works; deposits
  are scale-weighed and the ledger moves to the measured kg once every bag
  is weighed.
- **Release authority** (`RELEASE_AUTHORITY=paper`, D56): the warehouse's
  own record decides a release Farmledge can't confirm; `farmledge` makes
  an unconfirmed dispatch mean the bags stay. The tablet reads it from
  `GET /features` and words its dispatch screens to match.
- **Platform fees**: `POST /warehouses/:id/platform-fee-terms` with
  `model` (`none`, `per_bag` + `per_bag_rate_ngn`, `revenue_share`,
  `subscription`), `effective_from` and `set_by` (verifier).
- **Grading** (`GRADING_SCHEME`, `GRADE_VALUES`): change without a migration.
- **Prices** (`PRICING_PROVIDER=manual`): `POST /prices` with `commodity`,
  optional `grade`, `price_per_tonne_ngn`, `effective_from` and
  `entered_by` (verifier). Used only to value stock in reports.

## Chain jobs

With `CHAIN_ENABLED=true`, the receipt-contract jobs run from cron as
`npm run chain -- <job>`. The missed-anchor alert (urgent at 2 hours,
`docs/decisions.md` D48) depends on `index` running every 5 minutes.

```cron
*/5 * * * *  npm run chain -- index            # archive events, reconcile mints, missed-anchor check, hourly anchor retry
*/5 * * * *  npm run chain -- resolve-pending  # settle mints left pending
*/5 * * * *  npm run chain -- detect-reset     # Testnet: stop writers if the contract vanished
5 0 * * *    npm run chain -- anchor           # close and anchor each warehouse's days, in order
0 * * * *    npm run chain -- proofs           # deliver proof bundles, statements, retries
30 0 * * *   npm run chain -- keepalive        # extend receipt TTLs
0 1 * * *    npm run chain -- verify-archive   # gap check and reconcile
0 2 * * *    npm run chain -- backup           # archive and books, verified
```

Known limitations (`docs/decisions.md`): "delivered" means the SMS provider
accepted the message, and Testnet has never run with real warehouse
registrations.

## Layout

```
docs/decisions.md    decisions behind the rules, and open questions
docs/architecture.md ports and adapters: how to extend without rewriting
migrations/          SQL migrations
src/
  config/            env schema + typed, frozen config
  db/                pool, environment guard, migration runner
  domain/            pure business rules (validation, weights, report arithmetic); no I/O
  services/          database work per area; call domain rules, return views
  storage/           PhotoStore interface + local-disk implementation
  chain/ keys/ sms/ confirmation/ lending/ pricing/ platformFees/
                     one folder per port: the interface and its adapters
  adapters.ts        the one place adapters are chosen from config
  http/              app, typed errors, error handler, request logging,
                     request-shape parsing (parse.ts), routes
  cli/               `npm run migrate`, `accrue-fees`, `create-admin` and `set-pin` entry points
  server.ts          startup (guard → listen) and graceful shutdown
  main.ts            process entry: config, signals
apps/warehouse/      the counter PWA (its own package; see its README)
test/
  fixtures/          test-only sample records
  helpers/           throwaway database, env and API helpers
  domain/            unit tests for every domain rule
  api/               integration tests per endpoint against a real Postgres
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push. It builds,
typechecks, lints, checks formatting and runs the tests against a Postgres 18
service. It also migrates twice using `.env.example`, and runs
`docker compose up` to check the compose setup end to end.

## Licence

Proprietary. See [LICENSE](./LICENSE).
