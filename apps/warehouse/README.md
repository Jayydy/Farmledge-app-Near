# Farmledge warehouse app

The counter app warehouse staff use to record maize deposits with the
farmer present. One responsive PWA: installed full-screen and offline on an
Android tablet, and opened in any browser for demos.

React + TypeScript + Vite, a Workbox service worker (vite-plugin-pwa) and
IndexedDB (`idb`). It talks to the API in the repository root.

## Run it locally

Prerequisites: Node 24+, the API set up as in the root README (Postgres via
`docker compose up -d postgres`, `.env`, `npm run migrate`).

```bash
# 1. Demo records: a warehouse, a custodian, a verifier and one farmer
psql postgresql://farmledge:farmledge@localhost:5433/farmledge -f apps/warehouse/scripts/seed-dev.sql
echo 482915 | npm run set-pin -- --phone=+2348000000001   # from the repo root

# 2. The API (repo root), on http://localhost:3000
npm run dev

# 3. The app, on http://localhost:5173 (proxies /api to the API)
cd apps/warehouse
npm install
npm run dev
```

Sign in as **0800 000 0001**, PIN **482915**. The seeded farmer is
**0803 123 4567**. `FARMLEDGE_API_URL` points the proxy at another API.

`npm run dev` has no service worker. To try the installable, offline build:
`npm run build && npm run preview` (http://localhost:4173, also proxied).

| Script              | What it does                                                  |
| ------------------- | ------------------------------------------------------------- |
| `npm run dev`       | Dev server with hot reload, no service worker                 |
| `npm run build`     | Typecheck and build the PWA into `dist/`                      |
| `npm run preview`   | Serve `dist/` with the service worker, `/api` proxied         |
| `npm run typecheck` | `tsc -b`                                                      |
| `npm run lint`      | ESLint (strict, type-aware, React hooks)                      |
| `npm test`          | Unit tests (Vitest, `fake-indexeddb`)                         |
| `npm run test:e2e`  | End-to-end tests in Chrome against the real API (see Testing) |
| `npm run icons`     | Regenerates the PWA icons in `public/`                        |

## Install on an Android tablet

Service workers, the camera and `crypto.subtle` need a **secure origin**:
HTTPS, or `localhost`. Serve `dist/` and the API from one HTTPS origin
(the API under `/api`, see Deployment), open it in Chrome on the tablet,
then **⋮ → Install app** (or "Add to Home screen"). It opens full-screen
in landscape or portrait. Sign in once with signal; after that the app opens
and works with none. For a quick LAN demo without HTTPS, use Chrome's
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` on the tablet.

## Screens

Each screen asks one thing, with big buttons or a big number keypad. Always
on screen: the **status bar** (online/offline, sending, _N waiting_, _sync
failed_), the **HA/EN** language switch and the **Lock** button.

1. **Sign in**: phone, then PIN.
2. **Lock**: after 5 idle minutes, and whenever the app is reopened. The
   same custodian's PIN unlocks, offline too; "Someone else" discards what
   the last person started.
3. **Home**: New deposit, **Dispatch**, **Farmer balance**, the **Today**
   panel, today's deposits on this tablet, the queue, settings, end shift.
   Today (API D57), online: the warehouse's deposits in and dispatches out
   from every tablet, with two warnings: dispatches out **not weighed**, and
   dispatches **blocked offline** anywhere in the warehouse. Bag-estimated
   deposits are a plain figure on the In line, never a warning: they are
   the trial's normal case. Offline: only this tablet's own deposits, said
   as such.
4. **Intake**: farmer phone, then found ("Is this Musa Bello?") or register
   (name, data consent read aloud, then lender-lookup consent as a separate
   question), maize type, grade (1/2/3), moisture (one decimal, checked
   against the server's range), bags (above 300 asks again), verifier,
   optional scale sample (kept apart from the deposit weight), 1–3 photos,
   review with Change on every line, **Confirm deposit**.
5. **Saved**: shown only once everything is in IndexedDB. Says "Saved on
   this tablet" or "Received by the server", live, with the reference, a QR
   code and **Print slip**.
6. **Reprint a slip**: by farmer's phone or deposit number, then Print.
7. **Dispatch** (API D54), "Step n of 7", **online only**: farmer's phone;
   what they hold (each commodity and grade with its free bags; a line with
   none still shows, greyed, with why); bags out (more than the free balance
   says why and can't go on); lots (the server's oldest-first plan, every
   lot of the grade listed, pledged and minted ones marked with their
   reason, or **Choose a specific lot**); weight released (or **Not
   weighed** with a reason, under `bag_estimate` only); the farmer confirms
   a review read aloud; the custodian **signs off with their PIN**. Then the
   result: **Print delivery note**, from the server's record only.
8. **Farmer balance**: phone (or one tap on a farmer looked up recently),
   then bags and kg by commodity and grade, free versus held on-chain,
   storage fees owed, the last 30 days of deposits and dispatches, and
   **Print statement**.
9. **Daily summary** (online): one business day, back from today: each
   deposit in, each dispatch out with its weight or its recorded reason for
   none, the warehouse-wide blocked count, stock now (today only), and
   **Print summary**.
10. **Stock count** (online, API D57): who physically counted and who
    witnessed (typed names; the witness can't be a custodian here), then
    commodity and grade, bags counted, weight if weighed. **Blind**: what the
    system recorded for a commodity and grade shows only after its count is
    saved. **Finish count** gives the report: recorded vs counted for each,
    the total difference, stock nobody counted, and **Print report**. An open
    count is kept on the tablet, so the idle lock or a reload never strands
    it; Home offers **Continue stock count**.
11. **Waiting to send**: every item not yet sent, grouped by deposit, with
    its state, next retry, age warnings and **Try again**.
12. **Settings**: language, dispatches blocked offline on this tablet,
    remove this tablet.

### Dispatch and balance without signal

- **Dispatch never starts offline.** Without current data the tablet could
  release grain that was pledged or already dispatched, and a refused
  dispatch after the bags have left can't be undone. The button says
  "Needs a connection"; tapping it records the attempt (time, custodian,
  when the tablet was last online; nothing about the farmer or goods),
  queues it for `POST /warehouses/:id/dispatch-blocked`, and counts it on
  the tablet (Settings). If the trial shows this is frequent, the answer is
  a signed release authorisation issued while a lot is confirmed free, not
  queueing dispatches. What the screen tells staff about the bags follows
  the release rule in force (`release_authority`, API D56; see "Before
  field use").
- **Connection lost mid-way:** entries are kept; nothing is submitted until
  it is back.
- **Answer lost after submitting:** "Not confirmed", with a reference
  (`X-3F9A-C21B`) to write on paper. The request is saved on the tablet
  before it is first sent (`pendingDispatches`), so a reload, crash or flat
  battery loses nothing. While online it is sent again every 5 s, unchanged
  (the API ignores a repeat `dispatch_id`), and settled only by facts
  (`src/dispatch/pending.ts`): an answer means recorded; a 400, or a 409 on
  balance or lot, means not recorded; any other refusal (a 401, a 403) is
  settled by reading the dispatch, `GET /dispatches/:id`, with any sign-in
  on the tablet. Nothing prints until it is recorded. After 5 minutes
  **Leave pending** returns to Home, where the dispatch is listed with its
  state, keeps settling after every sync, and opens to its outcome.
- **Balance offline** shows only what this tablet saw online in the last
  24 hours (D55): greyed, under "OFFLINE: as of 14:05 (19 h ago). May have
  changed.", without fees or movements. A printed slip says "NOT CURRENT —
  as of …". A farmer not looked up here in 24 hours shows nothing.

## Offline storage

One IndexedDB database, `farmledge-warehouse` (`src/db/schema.ts`):

| Store               | Holds                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------- |
| `outbox`            | The sync queue: every write for the API, with status, attempts, next try, dependencies |
| `photoBlobs`        | Photo bytes (resized JPEG) until their upload is done                                  |
| `farmers`           | Lookup cache: id, phone, name of this warehouse's farmers, 7-day TTL (D43)             |
| `pendingDispatches` | Dispatches sent but not yet settled, and their outcome until someone has seen it       |
| `balances`          | Balances last seen online here: bags/kg by commodity and grade, free/held, 24-hour TTL |
| `deposits`          | What was captured here, for the saved, queue and reprint screens; slip data after sync |
| `sessions`          | Staff sign-ins on this tablet: token and a PBKDF2 check of the PIN for offline unlock  |
| `meta`              | Cached `/features`, language, directory refresh time, last online, blocked dispatches  |

**Confirming a deposit is one IndexedDB transaction** (`src/sync/capture.ts`):
the farmer registration (if new), the deposit, the scale sample, every
photo and its bytes, and the local record are written together or not at
all. The tablet generates every idempotency key at that moment
(`deposit_id`, `sample_id`, the photos' SHA-256), and they never change.

## Sync (`src/sync/engine.ts`)

- **When:** on start and unlock, when the connection comes back, after
  each save, every 30 s online, and from **Send now / Try again**. One sync
  at a time across tabs (Web Locks).
- **Order:** farmer registrations, then deposits through
  `POST /deposits/batch` (≤ 100 per request), then scale samples and photos,
  then blocked-dispatch records. Dispatches themselves are never queued.
  A new farmer's server id is filled into the deposits waiting on it.
- **Crash-safe:** each item is marked `sending` before its request and
  `done`/`failed`/back to `pending` after, in IndexedDB. An item still
  `sending` when the tablet closed goes back to `pending` and is sent again.
- **No duplicates:** resending is always safe. Deposits are idempotent on
  `deposit_id` and samples on `sample_id` (`duplicate: true`), photos on
  their bytes, and a farmer on phone (`409 farmer_already_registered`
  carries the existing id and counts as success). Retry never creates a new
  item.
- **Retry:** no answer, `5xx`, `429`: exponential backoff with jitter (5 s
  doubling to 10 min), forever. Any other `4xx` or a rejected batch item:
  **failed**, shown in red, retried only by a person. A `401` means the
  sign-in ended: the item waits, without using up attempts, for the
  custodian who captured it to sign in again.
- **Who sends:** each item is sent under the session that captured it (the
  API checks the named custodian is the signed-in one, D41), or that
  custodian's newest session.
- **Kept:** sent items for 14 days (reprints), then pruned. Pending and
  failed items are never deleted, by sign-out, deregistration or anything
  else.

## Sessions

- Sign-in is online (`POST /auth/sessions`). The tablet keeps the token and
  a PBKDF2 hash of the PIN, never the PIN.
- The screen locks after 5 idle minutes and on every reopen. Five wrong
  PINs at the lock screen forget the PIN check: an online sign-in is needed.
- **End shift** ends the session on the tablet. Its token is kept only
  while that person's captures are still queued, then revoked and deleted.
  Ending a shift never clears the queue.
- **Remove this tablet** (Settings) deletes the farmer cache, sign-ins and
  cached rules. The queue stays and is sent after someone signs in again.

## The slip and its QR code

Printing uses the system print dialog with a one-column layout that fits a
58 mm roll (`src/ui/styles.css`, `@media print`), so a thermal printer later
is a stylesheet change.

- **Before the API has the deposit:** "RECEIPT OF CAPTURE: NOT PROOF OF
  DEPOSIT", the reference (`D-1FCF-FEEE`, from the `deposit_id`) and a QR
  of `farmledge:capture:<deposit_id>`.
- **After:** "DEPOSIT SLIP" with the warehouse's deposit number, and a QR of
  `qr_payload` from `GET /deposits/:id/slip` exactly as the API gives it: the
  leaf's data and salt, as farmledge-protocol `docs/backend-requirements.md`
  §4 requires. **That encoding is provisional** (API `docs/decisions.md`
  D45) until farmledge-protocol#5 specifies it; the app passes it through
  untouched. Today's JSON needs a dense QR (about 0.48 mm per module at
  58 mm); options are in `docs/proposals/counter-slip-qr.md`.

## Reprinting a slip

Thermal slips fade, and for a farmer with no smartphone the slip is the
proof they carry, so replacing one takes seconds: **Home → Reprint a slip →
by farmer's phone or by deposit number → Print**. Any signed-in staff
member, any time, no request or approval (API D46).

- **Online:** every deposit at the warehouse, whichever tablet recorded it
  (`GET /deposits?farmer=` / `?deposit_no=`, then the slip with its names and
  proof payload).
- **Offline:** deposits recorded on this tablet, including ones not yet
  sent (those print as a capture receipt). A local record is kept for 14
  days after it is sent, so an older slip needs signal to reprint.
- The reprint says so on the slip: "REPRINT <time> by <name>. Replaces the
  earlier slip for this deposit."

## Before field use

### When a dispatch can't be confirmed

Which rule applies is set on the API (`RELEASE_AUTHORITY`, D56) and the
tablet words its screens to match.

**Shadow trial (`paper`).** The warehouse's own paper record is binding;
Farmledge runs beside it and **never blocks a release**.

1. If the tablet is offline, or shows "Not confirmed", the warehouse does
   what it always did: release by its own procedure and paper record.
2. Write the dispatch reference on the paper record when the tablet shows
   one, so the two records can be matched.
3. Leave the dispatch pending after 5 minutes if it hasn't settled, and
   serve the next person. It settles on its own when signal returns.
4. Any difference (a release Farmledge never recorded, or recorded twice)
   is found and reconciled at the next stock audit.

**Production, once receipts carry real claims (`farmledge`).** An
unconfirmed release is a genuine exposure, so Farmledge's record decides.

1. Wait at the counter up to **5 minutes** while the tablet retries.
2. Then **Leave pending**: write the reference, bags and time on paper for
   the farmer, and **do not release anything**. The farmer may wait or come
   back.
3. Release only when a tablet shows **Dispatch recorded** for that
   reference, and print the delivery note then. If it settles as **Not
   recorded**, start a new dispatch with the farmer.
4. If the tablet is lost or dies, or the day ends unresolved, the
   supervisor checks the reference from another tablet or through the API
   (`GET /dispatches/:id`); the bags stay until it is known. No release on
   paper.

### Manual checks

Manual checks that no automated test covers:

- [ ] **Slip QR on real hardware: untested.** Print slips on the actual
      thermal printer (58 mm, and 80 mm if considered), before and after
      sync, including creased and dusty paper. Scan both QR codes with the
      phones farmers and verifiers carry, in warehouse light. The proof QR is
      dense (QR version 19); see `docs/proposals/counter-slip-qr.md`.
- [ ] **Install on the target Android tablet** over HTTPS, then use it in
      flight mode: open, unlock, record, reopen, and sync on reconnect.
- [ ] **Reprint speed**: time a reprint of a week-old slip, from Home to
      paper, online and offline.
- [ ] **Delivery note and statement slip on the real printer**: print both
      (a statement online and one from the offline cache, with its NOT
      CURRENT line) on the thermal printer, and check they read at 58 mm.
- [ ] **Time a dispatch end to end** at the counter, from Home to the bags
      released, with a farmer holding several lots, one of them pledged.
- [ ] **Blocked-dispatch count**: switch the tablet to flight mode, try a
      dispatch, reconnect, and check the record reaches the API and the
      Today panel's warehouse-wide count on another tablet.
- [ ] **A stock count in the store**: walk a real count with a witness, the
      tablet locking on the way, and print the report at 58 mm. The witness
      is a typed name for now; a verifier signing in is API #48.
- [ ] **Hausa review** by a native speaker (see Languages), including every
      dispatch and balance string and the lot reasons read to farmers.
- [ ] **Sunlight and arm's length**: read every screen outdoors at the
      counter.

## Languages

Hausa and English from the first screen; the switch is always in the
header and remembered per tablet. Every English key must exist in Hausa
(`src/i18n/ha.ts` is typed against `en.ts`), and every API error code has a
plain message in both (a new code breaks the build).

> **`src/i18n/ha.ts` is a draft awaiting review by a native Hausa speaker.**
> The consent texts are read aloud to farmers and must say exactly what the
> English says. Set `HAUSA_REVIEWED = true` once reviewed; until then
> Settings shows a notice.

## API types are temporary

`src/types/api.ts` (and `src/lib/phone.ts`, `src/lib/pin.ts`) are
**hand-copied** from the API and marked TEMPORARY. They move to
`packages/shared` in the monorepo PR, where the API imports the same
definitions, so an API change breaks this app's build instead of failing in
a warehouse. Until then, change them together with the API.

## Testing

- **Unit** (`npm test`): the sync queue (`test/sync.test.ts`) against an
  in-memory API with the same idempotency rules: dependency order, backoff
  growth and jitter, offline then online, 5xx vs rejection, manual retry,
  a lost response after the server saved (exactly one record), a farmer
  already registered, one registration for two deposits, two concurrent
  syncs, 150 deposits in batches of 100, surviving close and reopen, an
  item caught mid-send, a refused session, retention. Plus sign-in, offline
  unlock, sign-out and the farmer cache's TTL and wipe (`test/device.test.ts`).
  The balance cache: only quantities kept, 24-hour expiry, per warehouse,
  wiped on deregistration (`test/balances.test.ts`). Blocked-dispatch
  records: sent once with only their four fields, and once after a lost
  answer (`test/sync.test.ts`). Pending dispatches: saved before the first
  send and kept across reopening; each answer the API can give, and which
  settle by themselves, which need the read, and which leave it unconfirmed;
  which sign-in sends and reads (`test/pending.test.ts`). The daily
  summary's figures, business dates in the warehouse's time zone, every
  deposit page, and the offline tablet-only count; the stock count's
  start, a line recovered from the report after a lost answer, and
  finishing (`test/summary.test.ts`).
- **End to end** (`npm run test:e2e`): starts the real API on a throwaway
  database (migrated, seeded, PIN set, `AUTH_REQUIRED=true`) and the built
  PWA, in Chrome:
  - `intake.spec.ts`: the whole intake flow online; checks the database.
  - `offline.spec.ts`: signs in, goes offline, **reloads (the app comes from
    the service worker)**, records two deposits (one with a farmer
    registered offline), comes back online, checks both land exactly once
    with their photos, sample and farmer, then reloads and checks again.
  - `reprint.spec.ts`: a slip recorded elsewhere, found and reprinted.
  - `dispatch.spec.ts`: refused beyond the free balance; pledged and minted
    lots listed with their reasons; the oldest-first allocation and a chosen
    lot as displayed; "not weighed" with a reason; a lot pledged after the
    plan, refused by the server and shown again; blocked offline, counted
    and sent on reconnect, with shadow-trial wording; an answer lost after
    the server recorded it, then a 401, settled by reading the dispatch, to
    exactly one, with nothing printed before; the production wording under
    `release_authority: farmledge`; left pending after 5 minutes, through a
    reload, then settled from Home.
  - `balance.spec.ts`: free versus held, fees and movements, printed; two
    taps for a farmer looked up before; offline, the cached figures with
    their age, greyed, no fees, and a NOT CURRENT slip; nothing for a farmer
    not looked up here.
  - `summary.spec.ts`: Today's not-weighed and warehouse-wide blocked
    counts; the daily summary's deposits, unweighed dispatch with its
    reason, stock and print, and another day; a stock count refusing the
    custodian as witness, blind until saved, surviving the lock, finished
    to a printed report, with counter and witness in the database.

  Needs Postgres at `TEST_DATABASE_URL` (default
  `postgresql://farmledge:farmledge@localhost:5433/postgres`, as
  docker-compose) and Chrome (`PLAYWRIGHT_CHANNEL=chromium` after
  `npx playwright install chromium` otherwise). Run `npm ci` in the repo
  root first: it uses the API's `migrate` and `set-pin` scripts.

## Deployment

Serve `dist/` as static files and the API under `/api` on the **same HTTPS
origin** (the API sends no CORS headers). `sw.js` must be served with
`Cache-Control: no-cache` so updates are found. A new version waits until
no intake is open, then asks to update.
