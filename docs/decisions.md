# Decisions

Rules that shape the code but aren't obvious from it. Each entry says what
was decided, why, where it lives, and what to change if it is revisited.
Open questions are at the end.

**Numbering.** D29–D40 belong to the receipt-contract work (PR #3) and are
cited in its code, but are not written up here yet. D29 and D31–D33 can be
reconstructed from the code. Only fragments survive of D30, D36, D38 and
D39. Nothing at all survives of D34, D35, D37 and D40. The tablet and
staff-auth decisions therefore start at D41.

## Units

### D1. Moisture: percentage outside, basis points inside

- **Rule.** External interfaces use a **percentage with at most one
  decimal** (`12.5`): API requests and responses, and the tablet. Internal
  storage, config (`MAIZE_MOISTURE_*_BPS`) and the receipt contract use
  **basis points of a percent** (`1250`).
- **Rejection, not rounding.** An incoming value with more than one decimal
  (`12.55`) is rejected with `invalid_moisture`. A moisture meter reads to
  one decimal, so extra digits mean a typo, and silently rounding a figure
  that affects grading would hide it.
- **Where.** Conversion happens only in `src/domain/units.ts`.
  `moisturePercentToBps` is called at the HTTP edge
  (`src/http/routes/deposits.ts`), and `bpsToMoisturePercent` when a
  deposit is turned into its API view. The range check (configured min and
  max) is a business rule in `validateDeposit`, on basis points.
- **If revisited.** To accept two decimals, change the precision check in
  `moisturePercentToBps` and its tests. Storage needs no change: basis
  points already hold two decimals of a percent.

## Intake limits

### D2. Bag count: confirm above a threshold, reject above a maximum

- **Rule.** A bag count above `BAG_COUNT_MAX` (**1000**) is always rejected
  (`bag_count_too_large`). A count above `BAG_COUNT_CONFIRM_ABOVE` (**300**)
  is accepted only when the request carries `confirm_bag_count: true`,
  otherwise `bag_count_needs_confirmation`. Both limits are exclusive:
  exactly 300 needs no confirmation and exactly 1000 is allowed.
- **Why.** A typo such as 2000 for 200 is caught, while a real truckload
  still goes through after a deliberate second look.
- **Record.** `deposits.bag_count_confirmed` is true when a confirmation was
  needed and given. A confirm flag sent for a small count is ignored.
- **Where.** `checkBagCount` in `src/domain/deposit.ts`. Config is checked
  at startup so that `BAG_COUNT_CONFIRM_ABOVE < BAG_COUNT_MAX`.

### D3. Offline captures: flag late ones, reject very late ones

- **Rule.** A deposit's `captured_at` (tablet time) may be at most 5
  minutes in the future (clock drift). If it is more than
  `OFFLINE_REVIEW_AFTER_HOURS` (**48**) old when it reaches the server, it is
  accepted with `review_reasons: ["late_capture"]` (`needs_review: true`).
  If it is more than `OFFLINE_REJECT_AFTER_HOURS` (**168**, 7 days) old, it
  is rejected (`captured_at_too_old`). Both limits are exclusive: exactly 48
  hours is not flagged and exactly 7 days is accepted.
- **Why.** A tablet out of signal for a day or two is normal and shouldn't
  block intake. A week-old capture is unusual enough to go through a
  supervisor by hand.
- **Other timestamps.** Scale samples (`recorded_at`) and audits
  (`started_at`) use the same reject limit, but are never flagged.
- **Where.** `checkCapturedAt` and `reviewReasonsFor` in
  `src/domain/deposit.ts`. The flag is stored in `deposits.review_reasons`
  (constrained to known reasons), and `GET /deposits?needs_review=true`
  lists flagged deposits.
- **Not built yet.** Clearing a review: see Q4.

## Farmers

### D4. One farmer per phone, registered at many warehouses

- A phone number identifies one person (`farmers.phone` is unique).
  Registering a known phone at another warehouse links the existing farmer
  through `farmer_warehouses`. Registering it twice at the same warehouse is
  a 409. A deposit's farmer must be registered at its warehouse, which a
  foreign key enforces.

### D5. Data consent is required; lookup consent is separate

- `consent: true` is consent for Farmledge to hold the farmer's data (NDPA
  2023). It is required, and its date is stored in
  `farmers.data_consent_at`. `lookup_consent` (lenders may find the farmer)
  is optional and independent.

## Deposits

### D6. Idempotency on the tablet's `deposit_id`

- The tablet generates a UUID per deposit, and single and batch submissions
  share it as the idempotency key.
  - A repeat with the same content returns the original (`200`,
    `duplicate: true`).
  - A repeat with different content is a 409 `deposit_id_conflict`, so a
    reused ID can never silently replace or lose a deposit.
  - `captured_at` and `confirm_bag_count` are not compared: a retry may
    legitimately omit them.
- Concurrency safety comes from the unique constraint and
  `INSERT … ON CONFLICT DO NOTHING`, not from locks.

### D7. Scale samples never change a bag-estimate weight

- Intake is by bag count (`weight_source = 'bag_estimate'`, weight = bags ×
  bag size). Scale samples on such deposits are spot checks.
  `GET /warehouses/:id/scale-summary` uses them to show how far real bags are
  from the assumed size. They never change `weight_kg`.

### D42. The tablet can check and retry everything it captures offline

- **Scale samples are idempotent** on an optional, tablet-generated
  `sample_id` (UUID), as deposits are on `deposit_id` (D6): an identical
  repeat is `200` with `duplicate: true`; the same ID with different
  content is a 409 `sample_id_conflict` with `differing_fields`
  (`recorded_at` is not compared). A repeat is answered before the
  "more bags than the deposit has" rule, so a retry of the sample that
  covered the last bags still converges. Without a `sample_id` a retry
  after a lost response records the sample twice, so the tablet always
  sends one.
- **`GET /features` carries the intake rules** (`intake`: commodities with
  bag size and moisture range in percent, bag-count limits, offline age
  limits, notes length, photo limits), so the tablet checks a deposit
  offline with the server's own numbers instead of a copy.

### D45. The counter slip's QR encoding is provisional

- **Today.** `GET /deposits/:id/slip` returns `proofs[].qr_payload`:
  `JSON.stringify(leaf)`, with the `Leaf` fields of the protocol's "Bundle
  format" in the API's key order, `salt` as hex, `day` set to the UTC day
  the entry was recorded, and `index: null` (the day's tree isn't built at
  the counter). There is no version or type tag.
- **Provisional.** Third parties must be able to check proofs without us,
  so the encoding belongs in the protocol, not in this API. It is being
  specified in farmledge-protocol#5 (in `docs/events.md`, accepted by
  `scripts/verify_proof.py`). Once that lands the API emits the specified
  format, and nobody should build on today's JSON.
- **Size.** Today's JSON needs QR version 19: about 0.48 mm per module on a
  58 mm slip, marginal for thermal printing. Options and a recommendation:
  `docs/proposals/counter-slip-qr.md`.

### D46. Any staff member reprints any slip, at once

- **Why.** Thermal slips fade in heat, and for a farmer with no smartphone
  the slip and its reprints are the only proof they carry. Replacing a
  faded slip must take seconds: any signed-in custodian, any time, with no
  request or approval step.
- **API.** `GET /deposits/:id/slip` also returns `printable`: the warehouse,
  farmer (name and phone), custodian and verifier names the slip prints, so
  a tablet that didn't capture the deposit can reprint it.
  `GET /deposits?deposit_no=` finds a deposit by the number on the slip;
  `?farmer=` by farmer.
- **Scope.** With a staff session these reads (`GET /deposits`,
  `/deposits/:id`, `/deposits/:id/slip`) cover the session's own warehouse
  only: another warehouse's deposit is a 403 `actor_mismatch`, and the list
  defaults to the session's warehouse.
- **Not logged.** A reprint is the same record printed again, so no reprint
  log is kept; the printed slip says it is a reprint, when and by whom.

### D47. Proof bundles go by SMS as a link and as plain text

- **Why.** A link needs a smartphone. A farmer with a feature phone must
  still hold a proof they can keep, show and forward, without a browser
  and without Farmledge.
- **Format.** `FLB1`, specified in farmledge-protocol#6: the compact bundle
  bytes from farmledge-protocol#5, as base32 (GSM-7 safe), with a short
  check, split into parts of at most 6 GSM segments, and a human line in
  the farmer's language. `verify_proof.py` will accept it pasted from a
  forwarded SMS.
- **When.** Alongside every bundle link already sent (deposits, dispatches,
  monthly statements), once protocol #5 and #6 are merged. Until then only
  the link is sent; no provisional text format goes to farmers.
- **Cost.** About 8 SMS segments per fresh deposit bundle.

### D8. Photos

- **Limit.** At most 3 per deposit, enforced by the service and a database
  trigger. The **minimum of 1 isn't enforced yet**: photos arrive after the
  deposit, so it belongs to the future step that submits a deposit for
  minting. `photo_count` is on every deposit.
- **Upload.** Raw image body, JPEG, PNG or WebP, checked against the file's
  signature bytes, up to `PHOTO_MAX_BYTES` (5 MB).
- **Storage.** Photos are content-addressed (SHA-256), so a retried upload
  is recognised. They go through the `PhotoStore` interface; today that is
  local disk under `PHOTO_STORAGE_DIR/<environment>/`.

## Data protection

### D43. The tablet's farmer cache is small, scoped and wipeable

Amended by D55: the tablet also keeps, for 24 hours, the balances of
farmers looked up on it.

- **Why.** Intake must find farmers by phone with no signal, so the tablet
  keeps a copy. A lost or stolen tablet must not expose a full farmer
  directory.
- **What the API gives.** `GET /warehouses/:id/farmers` lists only the
  farmers registered at the signed-in custodian's own warehouse (403
  `actor_mismatch` for any other), with `id`, `phone` and `full_name`
  only: no consent dates, other warehouses, balances or history. It always
  needs a staff session, even with `AUTH_REQUIRED=false`, and answers
  `Cache-Control: no-store`. Pages of up to 1000.
- **What the tablet keeps.** Only those three fields, each entry with a
  time to live (7 days since it was last confirmed by the server); expired
  entries are deleted, never used. A full refresh replaces the cache, so
  farmers removed from the warehouse drop out.
- **Wipe.** Deregistering the tablet deletes the farmer cache, the roster
  and every session. It never touches the outbox: queued deposits, photos
  and samples are records the warehouse owes the farmer, so they are sent
  first (or handed to a supervisor), not erased.
- **Not yet.** Wiping a lost tablet remotely needs a device registry. Today
  its sessions end when they expire (`STAFF_SESSION_TTL_HOURS`) or at once
  when the custodian is suspended, so the API stops answering it; what is
  already on the tablet is protected by the device's own lock and
  encryption, plus the 7-day cache expiry.

## Audits

### D9. Recorded stock is snapshotted; unweighed counts are estimated

- When an audit line is added, the system records its current stock for
  that commodity and grade from the stock ledger (D12), so dispatches and
  adjustments count as well as deposits. Later movements don't change the
  audit. (Before the ledger it summed deposits only, which would have shown
  every dispatch as a shortfall.)
- If `counted_kg` is omitted, it is taken as counted bags × bag size, and
  the line reports `counted_kg_estimated: true`.
- Percentages are rounded half away from zero to 2 dp. They are `null` when
  nothing was recorded.

## Access

### D10. No authentication yet (custodians: see D41)

- The acting custodian or verifier is named in the request body
  (`custodian_id`, `registered_by`, `recorded_by`, `uploaded_by`,
  `conducted_by`, `authorised_by`, `set_by`, `entered_by`, `requested_by`,
  `cancelled_by`, `reversed_by`, `assigned_by`)
  and trusted. Every service already checks that the
  person exists, is active and belongs to the right warehouse, so adding
  authentication means taking the ID from the session instead of the body.
- Custodians on the tablet's intake routes now sign in (D41). Everyone else
  (verifiers, owners, admins) is still named in the body and trusted.

### D41. Custodians sign in with phone and PIN

- **Why.** Custodian identity is the basis of co-signed minting, so the
  custodian a deposit names must be the person who was signed in, not
  whoever the request claims.
- **Sign-in.** `POST /auth/sessions` with `phone` and a 6-digit `pin`
  returns a bearer token, the custodian, their warehouse and the roster the
  tablet needs (active verifiers, names only). Only a scrypt hash of the
  PIN is stored; it is set with `npm run set-pin`, never through the API.
  One digit repeated or a straight run (123456) is refused.
- **Failures.** Unknown phone, no PIN, suspended custodian or inactive
  warehouse, and wrong PIN all answer the same 401 `invalid_credentials`, in
  about the same time. Five wrong PINs in a row lock the custodian out for 15
  minutes (429 `too_many_attempts` with `Retry-After`); `set-pin` clears it.
- **Sessions.** Only the token's SHA-256 is stored. A session ends when it
  is revoked (`DELETE /auth/sessions/current`), when it expires
  (`STAFF_SESSION_TTL_HOURS`, 168 h, the offline reject age, so a deposit
  captured offline can still be sent under the session that captured it),
  or when the custodian or warehouse stops being active. Short sessions on
  a shared tablet are the tablet's job: it locks after a few idle minutes
  and asks for the PIN again.
- **Actor.** With a session, the custodian the body names (`custodian_id`,
  `registered_by`, `recorded_by`, `uploaded_by`) must be the signed-in one,
  and a named `warehouse_id` must be theirs, or the request is a 403
  `actor_mismatch` (in a batch, that item alone is rejected). The body keeps
  naming them, so the API's request shapes are unchanged.
- **Which routes.** With `AUTH_REQUIRED=true` the tablet's intake routes
  need a session: `POST /farmers`, `GET /farmers`, `POST /deposits`,
  `POST /deposits/batch`, `GET /deposits/:id`, `GET /deposits/:id/slip`,
  `POST …/scale-samples` and `POST …/photos`; and dispatch and the farmer
  reads: `POST /dispatches` and `POST /dispatches/plan` (whose
  `custodian_id` and `warehouse_id` must be the session's),
  `POST /warehouses/:id/dispatch-blocked` (likewise), `GET /dispatches`,
  `GET /dispatches/:id`, `GET /dispatches/:id/delivery-note`,
  `GET /farmers/:id/balance`, `GET /farmers/:id/lots` and
  `GET /farmers/:id/statement`; and the stock audit and daily summary
  (D57): `POST /audits`, `POST /audits/:id/lines`, `POST /audits/:id/complete`,
  `GET /audits/:id/report`, `GET /deposits`, `GET /warehouses/:id/stock` and
  `GET /warehouses/:id/dispatch-blocked`. Other routes are unchanged
  until verifiers, owners and admins can sign in too (Q2, Q13). A token sent
  to any route is checked, and an invalid one is a 401 `session_invalid`.
- **Switch.** `AUTH_REQUIRED=false` keeps the D10 behaviour for tests and
  local scripts, but a token, when sent, is still enforced. Live refuses to
  start with `false`.

### D44. Verifiers are scoped to warehouses

- **Why.** A verifier's co-signature attests that someone authorised for
  _this_ warehouse checked the intake. If verifiers were valid anywhere, one
  from another store could co-sign a mint here. Custodians are already
  scoped to their warehouse; verifiers now are too.
- **Rule.** A verifier acts only at a warehouse they hold an active
  assignment for (`verifier_warehouses`): co-signing a deposit
  (`verifier_id`), conducting an audit (`conducted_by`), authorising a stock
  adjustment (`authorised_by`) and co-signing a mint (pledge
  `verifier_id`). Otherwise the API answers `verifier_wrong_warehouse`, and
  composite foreign keys make the row impossible in the database too.
  Platform fee terms (`set_by`) and manual prices (`entered_by`) are
  Farmledge settings, not attestations, and stay unscoped.
- **Several warehouses.** Unlike a custodian, a verifier may be assigned to
  more than one warehouse, which a field agent covering nearby stores needs.
  Each attestation is still tied to one assigned warehouse. Assignments are
  never deleted, only marked `removed`, since past attestations refer to
  them.
- **Migration.** Existing attestations were turned into assignments so every
  past row satisfies the new keys; review them, as they record where
  verifiers acted, not where they should. Assignments are made with SQL
  until an admin route exists, as verifiers themselves are.
- **Roster.** The tablet's sign-in roster (D41) lists only verifiers
  assigned to the custodian's warehouse.

## Grading

### D11. Grades are codes of a named scheme (provision h)

- **Rule.** `GRADING_SCHEME` names the scheme in force (`provisional`) and
  `GRADE_VALUES` lists its codes, best first (`1,2,3`). Every deposit,
  ledger row, dispatch, adjustment, audit line and price stores the scheme
  **with** the grade, as text.
- **API.** A grade may be sent as a code (`"G1"`) or, for numeric codes, a
  whole number (`1`). Responses always return the code as a string (`"1"`),
  plus `grading_scheme`.
- **Why.** Adopting a named standard (open question h) is then a config change with no
  migration. Stock graded under the old scheme keeps its old codes and
  scheme, so it is never silently reinterpreted; converting it is an
  explicit adjustment.
- **Where.** `src/domain/grading.ts` (`checkGrade`). Balances, reports and
  audits group by scheme and grade.

## Stock ledger

### D12. Stock is an append-only ledger; balances are sums

- **Rule.** Every change to stock is a row in `stock_movements`:
  `deposit_in`, `deposit_void`, `dispatch_out` or `adjustment`, with signed
  `bags_delta` and `kg_delta` and the time it physically happened
  (`occurred_at`). A balance (per warehouse, farmer, commodity, scheme and
  grade) is always `SUM` over the ledger (`stock_balances` view). No total is
  stored anywhere.
- **Append-only.** Triggers reject UPDATE, DELETE and TRUNCATE on the ledger,
  adjustments, fee schedules, accruals, payments, prices and platform fee
  terms. Mistakes are corrected by adding rows.
- **Never negative.** A trigger takes a per-balance advisory lock and refuses
  any row that would take bags or kg below zero, whatever wrote it. The
  services take the same lock (`lock_stock_balance`) and check first, so
  clients get a clean 409 `insufficient_balance`.
- **Deposits post themselves.** A trigger on `deposits` writes `deposit_in`
  at the deposit's capture time, and a `deposit_void` when its status becomes
  `rejected` or `cancelled`. Every path that records a deposit therefore
  keeps the ledger complete. Once posted, a deposit's farmer, warehouse,
  commodity, grade, bag count, bag size and capture time cannot change; a
  cancelled deposit cannot be reinstated.
- **Out of order.** `deposit_in` can be backdated (offline captures, within
  D3's 7 days), and a `deposit_void` is dated at its deposit's intake (D22).
  Dispatches and adjustments always happen "now". The trigger checks the
  current total; cancellation also checks every point in time (D22).
- **Adjustments** need a `reason_code` (`audit_correction`,
  `data_entry_error`, `spoilage`, `other`), notes, the recording custodian
  and an authorising verifier. They are idempotent on the client's
  `adjustment_id`, like deposits (D6). `scale_reweigh` is posted only by the
  system (D20).

## Dispatch

### D13. Dispatch is per grade; kg leaves in proportion

- **Rule.** A dispatch names commodity **and grade** and is checked against
  that balance; there is no oldest-first across grades. More bags than the
  balance holds is a 409 `insufficient_balance`.
- **Book kg.** The kg that leaves is the bags' share of the balance:
  `kg × bags_out ÷ bags`, to 2 dp. Taking every bag takes exactly the whole
  kg, so no residue is left.
- **Exit weight** is optional. With it, `shrinkage_kg = book_kg − exit_kg`
  (positive = loss). Unweighed dispatches are counted but left out of
  shrinkage percentages. Shrinkage is a reporting threshold, never a rule
  (D24).
- **Idempotent** on the tablet's `dispatch_id`, as D6.
- **Delivery note numbers** are sequential per warehouse:
  `<warehouse code>-DN-000001`. The note is JSON for the tablet to print and
  carries the environment, so a `test` note is visibly not real.
- **Buyer** is free text for now, not a platform user.
- **Confirmation** goes through the `FarmerConfirmation` port (provision e).
- **Side effects** in the same transaction: the ledger row, a chain intent
  (provision b) and the farmer's SMS (D19).

## Storage fees

These are what a **warehouse** charges its **farmers**. They are entirely
separate from what Farmledge charges a warehouse (D17).

### D14. Schedules: effective dates, insert-only, never repricing the past

- A schedule has a `basis` (`per_bag` or `per_tonne`), a `period` (`day`,
  `week`, `month`), a `rate_ngn`, an optional `minimum_days` and an
  `effective_from` date. It applies until the next one starts.
- **Per commodity, with a default** (D26): a schedule may name a commodity;
  one without is the warehouse default.
- **Owner only, with a reason** (D23). A custodian gets 403 `owner_required`.
- **History is never rewritten.** Schedules can't be edited, and a new one
  must start after the last accrued day (409 `schedule_would_reprice`), so
  every charge already made keeps the rate it was made at.
- **Daily rate.** Weekly ÷ 7. Monthly ÷ the days in **that calendar month**,
  so a full month adds up to the monthly rate (to the kobo).
- Charges are on the **end-of-day balance** in `BUSINESS_TIMEZONE`.

### D15. The accrual job

- `npm run accrue-fees [-- --through=YYYY-MM-DD]`, run daily by cron
  (default: through yesterday; never beyond today). It works out what
  should have been charged and appends the difference from what was charged:
  - a day charged for the first time gets a `daily` row;
  - a day already charged gets a `correction` row when stock captured
    offline arrives late. It never edits old rows. (A cancelled deposit's
    fees are reversed at once by contra entries, D22, so the job finds
    nothing left to correct.)
- It always rechecks the last `ceil(OFFLINE_REJECT_AFTER_HOURS / 24) + 1`
  days (8), which covers the oldest capture D3 accepts.
- Re-running with nothing new writes nothing: the job is idempotent, and
  runs are serialised by an advisory lock. Each run is logged in
  `fee_accrual_runs`; statements show `accrued_through`.
- **Minimum period.** When bags are **dispatched** before the schedule's
  `minimum_days`, a `minimum_topup` charges the missing days on the dispatch
  date. Dispatched bags are matched to the farmer's oldest stock first, and
  the minimum and rate are those of the schedule in force when that stock
  came in. Spoilage and other adjustments don't trigger top-ups.
- Amounts are stored to 4 decimals and shown to 2.

### D16. Payments and statements

- **Recording only.** `POST /fee-payments` records a payment the warehouse
  received: amount, reference, date, method. No money moves through
  Farmledge.
- A payment above the outstanding amount is rejected (409
  `payment_exceeds_outstanding`). The warehouse's `reference` is the
  idempotency key. A payment recorded in error is reversed, never deleted
  (D25).
- **Statement arithmetic.** Opening + accrued − paid = closing, exactly, in
  kobo: totals are rounded to kobo before they are differenced.
- Sending the statement by SMS is a `POST`, so reading a statement never
  sends anything.

## Owners, cancellation and reversals

### D22. Cancelling a deposit: mistakes only, fees reversed by contra entries

- **What it is for.** Cancellation corrects a deposit recorded by mistake.
  Grain that physically left is a **dispatch**, never a cancellation:
  if cancelling would take the farmer's balance below zero at any point
  since the deposit's intake, it is refused (409 `deposit_stock_dispatched`).
- **Who.** `POST /deposits/:id/cancel` with `cancelled_by` and a `reason`.
  Within `DEPOSIT_CANCEL_WINDOW_HOURS` (**24**) of the deposit being
  recorded, a custodian of the warehouse or its owner may cancel. After
  that, only the **warehouse owner** (403 `owner_required` for a
  custodian). The cancellation record itself can't hold an out-of-window
  cancellation by anyone but an owner.
- **Stock.** The deposit's `deposit_void` is dated at its **intake**, so the
  ledger shows no stock from it on any day.
- **Fees.** Every storage fee the deposit caused is reversed at once, back
  to its intake date, by **contra entries** in `storage_fee_accruals`
  pointing at the `deposit_cancellations` row, which carries the reason and
  authoriser. Each is the difference, per day, between what was charged and
  what would have been charged without the deposit, so afterwards the
  charges equal exactly that. Nothing is deleted or edited, and the accrual
  job finds nothing left to correct. Statements show them as
  `cancellation_reversal`.
- Minted deposits can't be cancelled (a receipt is exited); rejected or
  already-cancelled ones answer 409.

### D23. Warehouse owner is a separate role

- `warehouse_owners` sits beside `custodians`, one warehouse each. Owners
  change storage fees and the shrinkage tolerance, cancel deposits after
  the window, and reverse payments. Custodians run intake, dispatch and
  payment recording. As with custodians (D10), the owner's ID comes in the
  request for now. Owners are set up by Farmledge admins (D27).

### D24. Shrinkage is a reporting threshold, never a rule

- Every exit stores its variance and the **tolerance it was judged
  against**, and logs the variance (a warning when flagged). Above the
  tolerance it is flagged `shrinkage_above_threshold`
  (`GET /dispatches?needs_review=true`); it is **never rejected**.
- The tolerance is the warehouse's own for the commodity, else the
  warehouse's default, both set by its owner with a reason
  (`POST /warehouses/:id/shrinkage-tolerance`, history kept; D28), or else
  the configured default (`MAIZE_SHRINKAGE_TOLERANCE_BPS`, 2%). Changing it
  doesn't re-judge past exits. The field trial should give the real figure
  (Q7).

### D25. Payment reversal

- `POST /fee-payments/:id/reverse` with `reversed_by` (the **owner**; 403
  for a custodian) and a `reason`. A `fee_payment_reversals` row records
  who, why and when; the payment row stays. A payment is reversed at most
  once.
- Outstanding amounts count the payment until the reversal's date. A
  statement lists each payment with its reversal beside it, and counts the
  reversal in the period of its date, so opening + accrued − paid = closing
  still holds.

### D26. Fee schedules per commodity, with a default

- A schedule may name a commodity. For each day, a balance is charged under
  the latest schedule **for its commodity** in force; if there is none, the
  latest **default** schedule (no commodity). A later default never
  overrides a commodity's own schedule. Only maize exists now, so in
  practice warehouses set a default.

### D27. Warehouse owners are set up by Farmledge admins

- **Phase 1 is admin-only.** `POST /admin/warehouse-owners` with
  `assigned_by` (a Farmledge admin), `warehouse_id`, a `reason`, and either
  `full_name` and `phone` (a new person) or `custodian_id` (promote a
  custodian of that warehouse; the custodian record stays). Anyone else,
  custodians and owners included, gets 403 `admin_required`, so a custodian
  can't create or promote an owner, or change their own role.
- **Every assignment is logged** in `role_assignments` (append-only): the
  role, who received it, who gave it, when, why, and the custodian promoted
  from. The database refuses an admin or owner created without its log row
  in the same transaction, so hand-written SQL can't skip it either.
- **Admins are created only from the CLI**:
  `npm run create-admin -- --name= --phone= --reason= --operator=`. The log
  records the operator. No endpoint creates admins.
- **Self-service onboarding waits for Phase 2**, when many warehouses join
  and identity verification is needed.
- As with D10, `assigned_by` is trusted until authentication exists (Q2).

### D28. Shrinkage tolerance per commodity, with a warehouse default

- Same pattern as fee schedules (D26). `POST
/warehouses/:id/shrinkage-tolerance` takes an optional `commodity`; left
  out, it sets the warehouse default. An exit is judged against the latest
  tolerance for its commodity, else the latest warehouse default, else the
  configured default. A later default never overrides a commodity's own.
  `GET` shows each commodity's tolerance and its `source` (`commodity`,
  `warehouse` or `default`).
- Only maize is configured for the trial; there is no tablet UI for
  per-commodity tolerance yet.

## Platform fees

### D17. What Farmledge charges a warehouse is a separate model (provision g)

- Terms per warehouse with effective dates: `none` (default, no row needed),
  `per_bag`, `revenue_share`, `subscription`. `none` and `per_bag` work;
  the other two exist as stubs that report `implemented: false` and no
  amount.
- `GET /warehouses/:id/reports/platform-fees` charges each day's deposited
  bags under the terms in force that day.
- **Where.** `src/platformFees/platformFeeModel.ts`. A new model is one more
  entry in its table.

## Cross-cutting

### D18. Business days and one clock

- Reports, statements and fee accrual work in calendar days of
  `BUSINESS_TIMEZONE` (`Africa/Lagos`). Dates in and out of the API are
  `YYYY-MM-DD` in that zone.
- Business timestamps (intake, dispatch, adjustment, audit and sample times)
  come from the app's clock, not the database's `now()`, so the time used to
  validate a request is the time recorded.

### D19. SMS is queued with the change and sent after commit (provision d)

- A `notifications` row is written in the same transaction as the deposit or
  dispatch, then sent after commit through the `SmsGateway` port and marked
  `sent` or `failed`. A failed send never fails the request. English only for
  now (Q10). Today the gateway is `MockSmsGateway`, which logs messages.

### D20. Weight mode (provision f)

- `WEIGHT_MODE=bag_estimate` (default): deposits are `bag_estimate`.
- `WEIGHT_MODE=scale_required`: deposits are recorded as `scale`; the ledger
  starts at the bag estimate, and once scale samples cover every bag a
  `scale_reweigh` adjustment (authorised by the deposit's verifier) moves it
  to the measured kg.
- The rule that **only fully scale-weighed stock may be pledged** lives in
  one function, `assertPledgeable` in `src/domain/weightPolicy.ts`. Nothing
  pledges yet; the lock flow must call it.

### D21. Switches for things not built yet

Each open item below is a config value or a port with a working default,
picked in one place (`src/adapters.ts`; see `docs/architecture.md`).
Turning on something this build cannot do fails **loudly and early**: the
server refuses to start (`CHAIN_ENABLED=true`, `KEY_SERVICE=kms`), or the
one affected route answers 501 (`CONFIRMATION_MODE=sms_two_way`,
`LENDING_ENABLED=true`). `GET /features` tells the tablet the current
settings.

### D48. A missed anchor is urgent at 2 hours, and caught between daily runs

- **Why.** Nothing in a warehouse can mint until its latest day is
  anchored. During a single-warehouse trial a quietly failing anchor job
  blocks every pledge with no obvious cause.
- **Alerts.** A day not anchored 2 hours after its cutoff raises an
  **urgent** `anchor_missed` alert. At 24 hours a **separate**
  `anchor_missed_escalated` alert fires, so an on-call integration sees a
  new event rather than an update. A warehouse with no anchor for 7 days
  is urgent on its own (`no_anchor_7d`). All clear once the day is
  anchored.
- **Where it runs.** The check runs in the 5-minute `index` job as well as
  the daily `anchor` run, so a failed daily run is noticed within minutes
  rather than a day later. It runs even when indexing itself fails.
- **Retry.** While any warehouse has a day due but unanchored, the `index`
  job reruns anchoring at most once an hour across all processes. The
  hourly slot is claimed atomically in `job_runs`.
- **The pledge error.** A mint blocked by a missing or stale anchor is the
  409 `books_not_anchored`: "The warehouse's books are not anchored for
  today", naming the warehouse, its last anchored day and the cause
  (`missing`, `stale` or `moved_since_anchor`). The same error is used
  whether the contract refuses the mint in simulation or on-ledger, and
  when `resolve-pending` finds the failure later. The pledge records
  `failure_code`.
- **Three outcomes, never two.** `POST /pledges` answers within 20 seconds,
  well under common client and proxy timeouts, with one of: **201** settled
  (minted, awaiting the lender), **409** refused (with its cause), or
  **202 `minting`**, meaning _unknown, still resolving_. A 202 is never a
  failure: the mint keeps running and is settled by the request itself or
  by `resolve-pending`. Follow it with `GET /pledges/:id`.
- **Safe retries.** `pledge_id` is an optional, client-generated
  idempotency key. A retry with it, after a timeout or a lost response,
  returns that pledge's current state instead of refusing the lot.
  `lot_already_pledged` names the live pledge in `details.pledge_id`, and
  reusing a `pledge_id` for another lot is a 409 `pledge_id_conflict`.
  Reading a timeout as "failed" for a mint that later lands is the same
  proxy-for-truth error as the archive fallback (#15), one layer up.

### D49. Every day is anchored; an empty day gets a sentinel leaf (protocol #7)

- **Why.** A day with no entries used to be closed `empty` and never
  anchored. "No anchor for day N" then meant either "nothing happened" or
  "a day was suppressed", and suppressing a day hides movements.
- **The sentinel.** A day with no deposit, dispatch, record or balance is
  closed with one leaf of `kind` 3, as `farmledge-protocol` #7 specifies:
  `deposit_no` 0, `deposit_id` `""`, `NONE` commodity and grade, zero
  quantities, `deposited_at` = `at` = the cutoff, a fresh salt, and
  `owner`, `custodian` and `verifier` all the custodian who signs the
  anchor. The anchor of a sentinel day is signed by that custodian while
  they are active; if they are not, another signs it and a warning is
  raised. The contract refuses any leaf but kind 2 for a mint, so a
  sentinel never mints.
- **Enforced.** `checkDay` refuses a day with no entries and a sentinel
  beside any other entry. The database refuses a new `empty` day; days
  closed `empty` before this are history and stay as they are.

### D50. The pre-claim gate is always verified, never "not required" (protocol #10)

- **Why.** A gate recorded `not_required` opened with no check, so "nothing
  to claim, checked" and "never checked" looked the same.
- **Now.** The only open state is `verified`, with `verified_at` and
  `verified_by`. `verifyPreclaim` accepts an empty list. With no
  predecessor contract, the first pledge for a warehouse verifies its gate
  empty through the same checks (`verified_by` = `system: no predecessor
contract`), before its lot is frozen. With a predecessor, an unbuilt list
  (null) is refused; an empty one (`{}`) means the predecessor holds no live
  lots there.
- **The checks.** Every listed number is claimed on-chain; the archived
  `preclaimed` events for the warehouse are exactly the list; and the
  archive can stand for every event: it covers the start ledger to the
  cursor without a hole, and the cursor is within about an hour of the
  network.
- **Residual inference.** "No `preclaimed` event" is read from the archive
  up to its cursor, which can trail the network by up to 720 ledgers. An
  event in those ledgers is not seen here. The indexer pages on any
  `preclaimed` event when it archives it, since none is expected.

### D51. Tied entries sort by the source id they commit to (protocol #8)

- Tree order is rank (deposit, dispatch, balance, adjustment,
  cancellation), then `deposit_no`, then `at`, then the source id compared
  as bytes. A record's source id is its own `source_id` field, so a
  verifier rebuilding the tree from its contents gets the same order.
- Before this, a cancellation sorted by its `deposit_id` while committing
  its cancellation id. A lot is cancelled at most once, so no reachable
  tree changed; the order now holds by construction.

### D52. Keep-alive never misses a live receipt

- **Why.** Keep-alive read its list from the indexer's projection. A hole in
  the archive that swallowed a `minted` or `split` event left a live
  receipt off the list for good, and it would archive. (A missed exit fails
  safe: the contract skips a finished receipt.)
- **Ids are complete.** The contract assigns receipt ids 1, 2, 3, … and
  never reuses one. Each run reads the last assigned id from the contract's
  instance storage, reads every id the projection lacks from the chain,
  keeps the live ones alive, and raises an urgent
  `receipts_missing_from_projection` alert.
- **Statuses on a hole.** When the archive has a hole, a missed exit could
  make a finished receipt look live, and INV-9 forbids sending one. Every
  status is then read from the chain, and `keepalive_archive_gap` pages.
- **Still refuses** to run when the cursor trails the network by more than
  720 ledgers, as before.

### D53. Every warehouse is anchored from its registration day

- **Why.** A chain that starts at a warehouse's first intake leaves a
  verifier unable to tell a newly registered warehouse from one that has
  been operating unrecorded: the ambiguity sentinel leaves (D49) close
  mid-chain, moved to the start.
- **Rule.** The daily run anchors every registered warehouse, active or
  inactive, from the day the contract registered it: the first archived
  `warehouse_added` for its symbol on this contract, by the event's
  `added_at` (the ledger timestamp, the same clock `anchor` checks days
  against). A day with no entries is a sentinel day. The hourly retry and
  the missed-anchor alerts cover the same warehouses from the same day, so
  an idle warehouse that cannot be anchored (no active custodian, say)
  pages like any other.
- **Ground truth, not the row's creation time.** `warehouses.created_at`
  first stood for registration (#18). It failed silently one way: with
  `add_warehouse` first and the row here later, the days between were
  never anchored and never reported. Now the contract's day decides in
  both orders. Contract first: the days before the row are sentinel days,
  which is true, since nothing was recorded here. Database first: no day
  is closed until `add_warehouse` is archived.
- **No `warehouse_added` archived** for a warehouse registered here: none
  of its days is closed, so it pages instead, once its first day would
  have been late (2 h after the cutoff of the day its row was created).
  With the archive gap-free and current, `warehouse_not_on_contract`: the
  contract has not registered it. With holes, a trailing cursor or an
  unreadable network, `warehouse_registration_unknown`: nobody can tell.
  Both are urgent and resolve once the event is archived.
- **First, not last.** A warehouse removed and added again keeps its head
  on the contract, so its chain still starts at the first
  `warehouse_added`.
- **Cost.** One anchor per idle warehouse per day: 0.0051 XLM on mainnet
  today, 1.94 XLM a year (`farmledge-protocol/docs/archival.md`, measured
  with 2,048 leaves; a one-leaf sentinel day is still to be measured), and
  one first-day anchor (0.0444 XLM) per new warehouse. Active warehouses
  anchored daily already, so the added cost is only never-used warehouses
  and the days between registration and first intake.
- **Books begun before this rule** started at the first movement. The
  contract refuses any day not after its last anchored day, so their
  earlier days cannot be anchored now; a warehouse's chain starts at its
  first closed day where one exists, and days before it are not reported
  as missed.

### D54. What dispatch and the balance lookup read, and what an unweighed exit records

- **Lots with their state.** `GET /farmers/:id/lots?warehouse=` lists a
  farmer's lots holding stock, oldest first (the order dispatch draws
  them), each `free`, `pledged` (a mint is pending, so the lot is frozen,
  INV-1) or `minted` (with its `receipt_id`, INV-6). A lot that cannot
  leave carries `excluded_reason` in words, so a screen shows it with the
  reason and never just leaves it out.
- **Free versus held.** Each `GET /farmers/:id/balance` line adds
  `free_bags`/`free_kg` and `held_on_chain_bags`/`_kg`/`_lots`: the same
  split the delivery note's `balance_after` already gave.
- **A plan, not a promise.** `POST /dispatches/plan` returns the lots a
  dispatch would draw now, by the server's own rule (D29), with the same
  409s, and records nothing. The tablet shows it instead of copying the
  rule. `POST /dispatches` still decides, since a pledge or another
  dispatch can land in between.
- **An unweighed exit says why.** Without `exit_weight_kg`, a dispatch
  needs `not_weighed_reason`; with one, the reason is refused. A warehouse
  with no scale can still release grain, but "not weighed" is a recorded
  choice, not a gap. Bags out are always recorded. Dispatches before this
  rule have no reason (the database check is `NOT VALID`).
- **Dispatches by date.** `GET /dispatches?from=&to=` takes business dates,
  for the daily summary's figures (shown in the app's later summary work).
- **Blocked dispatches are counted, not described.** The tablet blocks
  dispatch offline, since it cannot know what was pledged or released
  meanwhile. Each blocked attempt is sent later to
  `POST /warehouses/:id/dispatch-blocked`: an id, the custodian, when, and
  when the tablet last had a connection. Nothing about the farmer, lot or
  quantity. Frequent blocks would argue for a signed release authorisation
  issued while a lot is confirmed free, not for queueing dispatches.
- **Sessions.** All of these need a staff session under
  `AUTH_REQUIRED=true` (D41); the plan and the blocked record must name the
  signed-in custodian and their warehouse.

### D55. The tablet keeps balances it saw online, for 24 hours, quantities only

Amends D43, which kept no balances on the tablet.

- **Why.** Balance lookup offline should still answer "about how much do I
  have here", but never show old numbers as current, and a shared tablet
  holding what each farmer has stored and owes is a physical security risk
  here, not only a privacy one.
- **What the tablet keeps.** For each farmer looked up online on this
  tablet, at its own warehouse only: bags and kg by commodity and grade,
  split free / held on-chain. No fee amounts, no movement history, no lot
  numbers. Each entry expires 24 hours after the server returned it; expired
  entries are deleted, never shown.
- **How it is shown.** Greyed, under "OFFLINE: as of <time> (<age> ago).
  May have changed.", without fees or movements; a printed slip carries
  "NOT CURRENT — as of <time>". A farmer not looked up here in 24 hours
  shows nothing offline.
- **Wipe.** As D43: deregistering the tablet deletes it.
- **Dispatch uses none of it.** Dispatch is online only and reads lots and
  balances from the API at each step (D54).

### D56. Whose record decides a release Farmledge can't confirm

- **Why.** Dispatch is online only (D54), and a submitted dispatch can be
  left unconfirmed. Whether that stops a release depends on which record is
  binding. In the shadow trial the warehouse's paper record is binding and
  Farmledge runs beside it: if Farmledge's not confirming could block a
  release, a non-authoritative system would have become authoritative.
- **Switch.** `RELEASE_AUTHORITY`, reported as `release_authority` in
  `GET /features`.
  - `paper` (the shadow trial): Farmledge never blocks a release. If it
    can't confirm, the warehouse does what it always did; the difference
    is recorded and reconciled at the next stock audit.
  - `farmledge` (production, once receipts carry real claims): an
    unconfirmed dispatch means the bags stay until a tablet shows it
    recorded, since an unconfirmed release is then a genuine exposure.
- **Refused with lending on.** Whether receipts carry real claims isn't in
  the configuration, but lending being on is the observable sign of it. The
  server refuses to start with `LENDING_ENABLED=true` and
  `RELEASE_AUTHORITY=paper`, in any environment: the dangerous mistake is
  paper mode left on once receipts are binding. Otherwise the choice is a
  deliberate deployment decision.
- **The API is the same in both.** Only what the tablet tells staff
  changes; dispatch is still refused offline and beyond the free balance.

### D57. A stock count names who counted and who witnessed; the summary reads stay at the session's warehouse

- **Why.** An audit run by whoever manages the stock is evidence of
  nothing: a custodian discrepancy is exactly what it is meant to find. The
  custodian may enter the figures on the tablet, but the record has to name
  who physically counted and who watched, and the watcher can't be that
  custodian.
- **Who.** `POST /audits` takes `counted_by` and `witnessed_by`, required,
  as typed names (1–120 characters, spaces tidied). A witness whose name
  matches any custodian registered at the warehouse, ignoring case and
  spacing, is refused (`witness_is_custodian`). An audit names the custodian
  entering it (`entered_by`), the verifier conducting it (`conducted_by`,
  D44), or both; `conducted_by` is no longer required. Typed names prove
  little: anyone can type one. The proper fix is a witness who signs in as
  a verifier, which waits on verifier sign-in (#48). Audits from before
  this name neither and stay as they are (the database check is
  `NOT VALID`).
- **Sessions.** With a session, `entered_by` and `warehouse_id` must be
  the signed-in custodian's (403 `actor_mismatch`), so a verifier alone
  can't be named from the tablet. Another warehouse's audit is not found
  (404), for lines, completion and the report alike.
- **Summary reads.** `GET /deposits` takes `from`/`to`, business dates of
  intake. `GET /warehouses/:id/stock` with a session must name the
  session's warehouse.
- **Blocked dispatches, warehouse-wide.** `GET /warehouses/:id/dispatch-blocked?from=&to=`
  returns how many dispatches were refused offline there, from every
  tablet. The trial question is how often connectivity stops work at a
  warehouse, not on one device. Tablets send these when they reconnect, so
  a day's count can still rise afterwards.

## Known limitations

Not bugs: things this backend does not know, stated so nobody infers them.

- **"Delivered" means accepted by the SMS provider.** A proof delivery is
  marked `sent`, with `delivered_at`, when the provider accepts the message,
  not when a handset receives it. No handset delivery receipts are
  collected yet, so a farmer's phone being off or out of credit is
  invisible here.
- **Testnet has never run with real warehouse registrations.** The chain
  path is exercised by the test suite and the Testnet suite with their own
  registrations, but no real warehouse, custodian or verifier has been
  registered on the deployed contract and anchored from this backend.
- **A registration before the archive starts is invisible.** A warehouse
  the contract registered before the indexer's start ledger has no
  archived `warehouse_added`: its books do not start, and it pages as
  not on the contract when it is. A direct read of the contract would fix
  the alert but not the start day, which only the event carries. None is
  registered so, today.
- **Movements before `add_warehouse` roll forward.** Entries recorded here
  before the contract registered the warehouse go into its first anchored
  day's tree, at their own times; no earlier day is anchored for them.
- **Books begun before D53** start at their first movement, and nothing
  marks their days between registration and that movement on-chain.
- **The page's grace period uses the row's creation time.** Only to
  decide when a missing registration is late, never where a chain
  starts.
- **Inactive warehouses are anchored forever.** Decommissioning a
  warehouse (removing it from the contract and ending its chain) is not
  defined; until it is, an inactive warehouse costs one anchor a day.
- **Facts inferred from a proxy.** Each is a reading of something nearby,
  not the fact itself:
  - _No `preclaimed` event_ is read from the archive up to its cursor (D50).
  - `book_anchors.anchored_ledger` is the anchor transaction's ledger, or
    the latest ledger when the anchor was found already on-chain, and
    `anchored_at` is when it was recorded here. Both are approximate and
    informational. Nothing orders or decides freshness by them: the mint
    uses the anchored day checked against `get_anchor`, and reconciliation
    orders by the ledgers of archived events.
  - Reconciliation's "no later anchor before the mint" check sees only
    archived `anchored` events. An archive hole hides a violation rather
    than raising a false one.
  - A Testnet reset is inferred from a missing contract instance or a
    ledger below the start ledger. An instance archived by a lapsed TTL
    reads as missing, which halts every chain writer, keep-alive included,
    until someone clears the alert. Nothing is cleared or re-pointed
    automatically; that needs `npm run chain-reset`.

## Open questions

### Provisions (a–i)

| #   | Open question                                                    | Current default                                                                                                               | What changes when it's answered                                                                                            |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| a   | Lending: lock, unlock and recovery of receipts                   | `LENDING_ENABLED=false`: routes answer 501 `feature_disabled`. `true`: validated, then 501 `not_implemented`                  | Implement `LendingService` (`src/lending/`) and swap it in `src/adapters.ts`; the lock flow calls `assertPledgeable` first |
| b   | When receipts go on chain (Stellar/Soroban)                      | `CHAIN_ENABLED=false`: `NoopChainClient` records intents in `chain_intents`, chain refs stay null. `true` refuses to start    | Implement `SorobanChainClient` (`src/chain/`); a worker can replay `chain_intents`                                         |
| c   | Key custody for custodians, verifiers and the platform           | `KEY_SERVICE=local_dev`: Ed25519 keys derived from `KEY_SERVICE_LOCAL_SECRET`, every signature logged. `kms` refuses to start | Implement `KmsKeyService` (`src/keys/`)                                                                                    |
| d   | SMS provider                                                     | `SMS_GATEWAY=mock`: messages logged; deposit, dispatch and fee statement messages already wired                               | A new `SmsGateway` adapter and a new `SMS_GATEWAY` value                                                                   |
| e   | How farmers confirm actions on their stock                       | `CONFIRMATION_MODE=tablet_only`: `farmer_confirmed: true` approves at once. `sms_two_way`: dispatch answers 501               | Implement `SmsTwoWayConfirmation`: it records `pending` with `external_ref`, and an inbound handler approves it            |
| f   | Must intake be weighed?                                          | `WEIGHT_MODE=bag_estimate`. `scale_required` works (D20)                                                                      | Flip the variable; the pledge rule is already in `assertPledgeable`                                                        |
| g   | How Farmledge charges warehouses                                 | Per-warehouse terms; no row means `none`. `per_bag` works; `revenue_share`, `subscription` are stubs (D17)                    | Fill in the stub in `src/platformFees/platformFeeModel.ts` and any parameters it needs                                     |
| h   | Which maize grading standard, and what moisture limits? (was Q1) | `GRADING_SCHEME=provisional`, grades `1,2,3`; moisture 0–13.5% (placeholders)                                                 | Set `GRADING_SCHEME` and `GRADE_VALUES` (and `MAIZE_MOISTURE_*_BPS`). No migration; old stock keeps its scheme (D11)       |
| i   | Where prices come from                                           | `PRICING_PROVIDER=manual`: entered through `POST /prices`, used only to value stock in reports                                | A new `PricingProvider` (`src/pricing/`) and `PRICING_PROVIDER` value                                                      |

### Other open questions

Answered since: who sets fee schedules (owner only, D23), refunding fees on
cancellation (contra entries, D22), payment correction (reversal, D25) and
per-commodity fees (D26), and how owners are registered (admin-only, D27).

| #   | Question                                                          | Current default                                                                                     | What changes when it's answered                                                            |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Q2  | How do verifiers authenticate?                                    | Custodians sign in (D41); verifier IDs in the request, trusted (D10)                                | A verifier session (or co-signature) on the same middleware as D41                         |
| Q3  | Must a deposit have at least one photo, and when is that checked? | Not enforced (D8)                                                                                   | Check at the "submit for minting" step                                                     |
| Q4  | Who clears a `late_capture` review, and how?                      | Flag only; no clearing endpoint                                                                     | A review endpoint that records reviewer, decision and time                                 |
| Q5  | Where do photos live in production?                               | Local disk behind `PhotoStore`                                                                      | A new `PhotoStore` implementation (e.g. object storage), chosen in `server.ts`             |
| Q6  | Should the moisture range differ by commodity?                    | Both maize types share one range                                                                    | Separate env vars per commodity in `src/config/`                                           |
| Q7  | What shrinkage is acceptable at exit?                             | 2% default, per-warehouse and per-commodity override; flags only (D24, D28)                         | Set each warehouse's tolerance, or change the default, from trial data                     |
| Q10 | SMS languages                                                     | English only                                                                                        | Translated templates in `src/domain/smsTemplates.ts`, chosen per farmer                    |
| Q13 | How are warehouse owners authenticated?                           | Set up by an admin (D27); ID in the request, trusted                                                | The same middleware as Q2; self-service onboarding with ID checks in Phase 2               |
| Q14 | What share of depositors have a smartphone?                       | Unknown: no warehouse partner yet. Designed for none: slip + reprint (D46) and plain-text SMS (D47) | Weight given to the link vs the text SMS; reprint volume. In the pre-pilot field questions |
