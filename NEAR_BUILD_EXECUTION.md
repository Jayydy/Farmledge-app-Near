# farmledge-app — NEAR Branch Build Execution Plan

Branch **`near-hackathon`** of `farmledge-app`: run the existing backend
against the NEAR receipt contract (`farmledge-protocol-near`) instead of
Soroban, **without breaking the Stellar path**. Companion to
`farmledge-protocol-near/BUILD_EXECUTION.md`.

> [!IMPORTANT]
> **Contract-surface gate (resolve on Day 0).** The app is *anchor-first*:
> deposits go into a daily Merkle book, `anchor` commits the root on-chain,
> and a receipt is only minted **at pledge time** via `mint_from_anchor`
> (`src/services/pledges.ts`). The protocol-near plan currently follows the
> older skeleton (`propose_mint`/`approve_mint`, anchoring as stretch).
> **The NEAR contract must expose the §2 surface** or `pledges`, `anchoring`,
> `proofs` and invariants INV-2/5/6/7 stop working. The protocol plan
> must be revised to match §2 before contract work starts.

---

## 1. Principles

- **Ports and adapters, as `docs/architecture.md` prescribes:** NEAR is one
  new `ChainClient` adapter picked in `src/adapters.ts`. Services stop
  importing `@stellar/stellar-sdk` directly. Chain-specific logic moves
  behind the port.
- **Additive migrations only** (`021+`, with `-- Up/-- Down`). Never edit `001–020`.
- **Both chains stay green:** CI runs the full suite under
  `CHAIN_BACKEND=stellar` and `CHAIN_BACKEND=near`.
- **Keep D30 / D31 / INV-1 semantics:** record-before-submit, no blind
  retries, never hold a lender key, mint deadlines enforced.
- **Separate deployment:** own Postgres DB, own `.env`, own hosting target.
  The Stellar pilot DB is never pointed at this branch.

---

## 2. What the app needs from the NEAR contract

The app's contract requirements, mapped from `ChainClient`. This must match
the revised protocol-near §4.

| `ChainClient` method | NEAR contract call | Notes |
|---|---|---|
| `anchor` | `anchor(warehouse_id, day, root, leaves)` — caller = custodian | Single signer, so it maps directly to NEAR |
| `mintFromAnchor` | `propose_mint(leaf, proof, not_after)` (custodian) → `approve_mint(warehouse_id, deposit_no, leaf_hash)` (verifier) | Two txs, both signed by app-held keys. **`not_after` checked in-contract** (≤ now + 300 s; NEAR txs have no `max_time`; see §6) |
| `prepareLock` / `submitLock` | `offer_lock(receipt_id, kg, loan_ref, due_date, grace_period, expires_at)` (lender, own wallet) → `accept_lock(receipt_id, lender, kg, loan_ref, due_date, grace_period)` (owner/farmer key; terms must equal the offer) | D31 still holds: the lender signs their own transaction |
| `getAnchor` | view `get_anchor(warehouse_id)` → `{day, head}` | |
| `getReceipt` | view `get_receipt(receipt_id)` | `U64` as JSON strings |
| `lastReceiptId` | view `last_receipt_id()` | |
| `isClaimed` | view `is_claimed(warehouse_id, deposit_no)` | |
| `leafHash` | view `leaf_hash(leaf)` | Cross-check oracle for `merkle.ts` |
| `receiptLiveUntil`, `extendTtlBatch` | — | **No TTL on NEAR.** Returns "never expires" / no-op |
| `instanceExists` | RPC `view_account` → `code_hash != 1111…` | Detects a missing or wiped contract |
| `latestLedger` | RPC `block {finality: final}` → `{height, timestamp}` | "Ledger" means "block height" from here on |
| `getEvents` | Indexer over finalized blocks (§5.4) | NEP-297 `EVENT_JSON` logs |

**Leaf hash on NEAR:** `sha256(0x00 ‖ borsh(Leaf))`. The Borsh field order and
the `WeightSource` discriminants are fixed in protocol-near §4.2. Node, padding
and head rules stay as they are. The app must reproduce the protocol's
committed `test-vectors/leaf_hash.json` byte for byte.

**Error codes:** the NEAR contract returns `E{code}:{Name}`. It reuses the v3
codes in `chainClient.ts`'s `ContractError` (11, 12, 21, 22, 30, 36, 50–57) so
service logic doesn't change. The new NEAR-only codes are 70–77 (protocol-near
§4.8). `PendingExpired` (72) maps to the INV-1 `expired` outcome.

---

## 3. Tech stack (additions only)

| Concern | Choice | Version |
|---|---|---|
| NEAR client | `near-api-js` (or modular `@near-js/accounts`, `@near-js/transactions`, `@near-js/crypto`, `@near-js/providers`) | `7.x` |
| Typed RPC | `@near-js/jsonrpc-client` | `1.x` |
| Borsh (leaf hash, tx hashing) | `borsh` (via `@near-js/transactions`) | bundled |
| Indexer source | FastNEAR **neardata** (`/v0/block/{height}`, finalized blocks with outcomes) | HTTP |
| Sandbox tests | `near-workspaces` (JS) or the `near-sandbox` binary | latest |
| Base58 | `bs58` (tx hashes) | latest |
| Unchanged | Node ≥ 24, TypeScript, Express 5, pg, node-pg-migrate 9, Zod 4, Pino, Vitest | — |

`@stellar/stellar-sdk` stays as a dependency. It should only be imported in
`src/chain/soroban*` and `src/chain/stellar*`. Add a lint rule for this (§7).

---

## 4. Database migrations

### `021_chain_backend.sql`, the NEAR-compatible schema

```sql
-- Up Migration
-- Which chain a deployment / transaction belongs to. Existing rows are Stellar.
ALTER TABLE chain_deployments  ADD COLUMN chain TEXT NOT NULL DEFAULT 'stellar'
  CHECK (chain IN ('stellar','near'));
ALTER TABLE chain_transactions ADD COLUMN chain TEXT NOT NULL DEFAULT 'stellar'
  CHECK (chain IN ('stellar','near'));
ALTER TABLE chain_transactions ADD COLUMN envelope_encoding TEXT NOT NULL DEFAULT 'xdr'
  CHECK (envelope_encoding IN ('xdr','borsh_b64'));
ALTER TABLE chain_transactions ADD COLUMN signer_nonce NUMERIC(20,0);  -- NEAR access-key nonce

-- Replace Stellar-only format checks with chain-aware ones.
--   NEAR account id: 2–64 chars, [a-z0-9._-] (implicit accounts = 64 hex)
--   NEAR tx hash   : base58, 43–44 chars
```

Then, for each constraint below: `DROP CONSTRAINT <auto-name>` and `ADD CONSTRAINT … NOT VALID`,
followed by `VALIDATE CONSTRAINT` (existing Stellar rows pass the Stellar branch):

| Table.column | From | To |
|---|---|---|
| `chain_deployments.contract_id`, `.predecessor_contract_id` | `^C[A-Z2-7]{55}$` | `(chain='stellar' AND ~ '^C[A-Z2-7]{55}$') OR (chain='near' AND ~ near_account_re)` |
| `chain_transactions.tx_hash` | `^[0-9a-f]{64}$` | Stellar hex **or** NEAR base58 by `chain` |
| `pledges.lender_address` | `^G[A-Z2-7]{55}$` | `^G[A-Z2-7]{55}$` **or** NEAR account regex (pledges has no `chain` column, so accept either and validate strictly in the app) |
| `deposits.mint_tx_hash`, `<008>.chain_tx_hash` | 64 hex | hex **or** base58 |

Also:
- The immutability trigger on `chain_transactions` (011 L120-130) compares
  `envelope_xdr`. That stays correct because the column name is unchanged and
  holds base64 borsh on NEAR.
- `network_passphrase` holds a network id for NEAR (`near:testnet`). No rename.
- `-- Down Migration` restores the original constraints. It **fails loudly
  if NEAR rows exist**, which is intended.

> Look up the generated constraint names with
> `SELECT conname FROM pg_constraint WHERE conrelid='chain_transactions'::regclass;`
> and hard-code them in 021. Don't drop constraints by guessing.

### `022_near_pending_intents.sql`, for two-step mint/lock tracking

- `chain_transactions.purpose` gains `'mint_propose'`, `'mint_approve'`,
  `'lock_accept'`. (Extend the CHECK if one exists, otherwise skip.)
- `pledges.lender_offer_tx_hash TEXT` (NEAR): the lender's `offer_lock` tx,
  submitted by the lender portal and verified by the app before `accept_lock`.
- `pledges.status` gains `'awaiting_lender_offer'` if it's CHECK-constrained.
  On NEAR it replaces `'awaiting_lender_signature'`.

### Migration tests (`test/migrations.test.ts` + new `test/migrations/021_022.test.ts`)

- Up → down → up is clean on an empty DB **and** on a DB seeded with Stellar fixtures.
- Each relaxed CHECK: accepts a valid Stellar value, accepts a valid NEAR value,
  rejects garbage, and rejects a cross-chain mismatch (`chain='near'` with a `C…` id).
- Down fails while NEAR rows exist.
- `TABLES` list unchanged, so no accidental table drops.

---

## 5. Code changes

### 5.1 Generalise the port (`src/chain/chainClient.ts`)

| Change | Why |
|---|---|
| `networkPassphrase` → `networkId` (keep a getter alias for Stellar) | Chain-neutral |
| `latestLedger()` → returns `{ sequence /* = height on NEAR */, closeTime }` | Same shape, documented meaning |
| `ChainEvent`: replace `topicXdr`/`valueXdr` with `decoded: DecodedEvent` + `raw: string` | Moves `decodeEvent` out of `indexer.ts` into each adapter |
| `ChainTxOutcome.returnValueXdr` → `returnValue: unknown` (decoded by adapter) | Removes `scValToNative` from `pledges.ts` |
| Add `validateAccount(s: string): boolean` | Replaces `StrKey.isValidEd25519PublicKey` in `pledges.ts` |
| `PreparedLock` → union: `{ kind: 'soroban_auth', … } \| { kind: 'near_offer', txRequest }` | Lender UX differs per chain |
| `submitLock(…, lenderProof: string, …)` | Signed XDR entry on Stellar, `offer_lock` tx hash on NEAR |
| Add `capabilities: { ttl: boolean }` | `keepAlive` skips when `ttl=false` |

`SorobanChainClient`, `NoopChainClient` and `test/helpers/fakeChain.ts` are
updated to the new shape **first, with no behaviour change** (Stellar suite must stay green).

### 5.2 New adapter `src/chain/nearChainClient.ts` (+ `nearRpc.ts`, `nearEvents.ts`, `nearLeaf.ts`)

- **Signing:** `KeyService` already produces Ed25519 keys. Each subject maps to
  a **NEAR implicit account** (`hex(pubkey)`), so no account creation is needed.
  `addressFor()` becomes chain-aware.
- **D30, record before submit:** build tx → sign through `KeyService` → compute
  hash (`sha256(borsh(tx))`, base58) → `INSERT chain_transactions` → `send_tx`
  (`wait_until: FINAL`) → on timeout, `resolve` with `tx` status by hash.
  Resending the identical signed tx is safe (nonce dedupe).
- **Nonce discipline:** one in-process mutex per subject plus a nonce read from
  `view_access_key`. Persist `signer_nonce`. Never sign two txs with the same nonce.
- **Gas/funding:** the operator funds implicit accounts on first use (small
  transfer). Upgrade path: NEP-366 meta-transactions with operator as relayer.
- **Errors:** parse `E{code}:` from `FunctionCallError.ExecutionError` → `ContractCallError(method, code, msg)`.
- **Leaf encoding (`nearLeaf.ts`):** borsh schema for `LeafJson`, with field
  order fixed and matching the Rust struct.

### 5.3 Services: chain-agnostic cleanup

| File | Change |
|---|---|
| `src/adapters.ts` | `createChainClient`: `switch (config.chain.backend)` picks `SorobanChainClient` or `NearChainClient` |
| `src/chain/addresses.ts` | `addressFor(keys, subject, chain)`: StrKey for Stellar, hex implicit id for NEAR |
| `src/domain/merkle.ts` | `leafHash(leaf, encoder)`. The XDR encoder moves to `src/chain/stellarLeaf.ts`, the borsh encoder to `nearLeaf.ts`. Tree, node, pad and head stay unchanged |
| `src/services/pledges.ts` | Drop direct `@stellar/stellar-sdk` imports. Use `chain.validateAccount`, decoded `returnValue`, and the `PreparedLock` union. New state `awaiting_lender_offer` on NEAR |
| `src/http/routes/pledges.ts` | NEAR: `POST /pledges/:id/lender-offer { txHash }`. The app verifies `signer_id == lender`, method/args match and the tx succeeded, then calls `accept_lock` |
| `src/services/indexer.ts` | Consumes `ChainEvent.decoded`. `decodeEvent` moves into the adapters. The cursor stays a number (block height) |
| `src/services/keepAlive.ts` | Early return when `!chain.capabilities.ttl` (INV-9 marked N/A for NEAR) |
| `src/services/chainDeployment.ts` | Binds on `(chain, contract_id, networkId)`. Error text becomes chain-neutral |
| `src/services/archiveBackup.ts` | Archives `raw` + `decoded`, not XDR |
| `src/services/proofs.ts` + public bundle page | Bundle carries `chain` + `encoding`. The verify page uses the matching leaf encoder and links to NearBlocks |
| `src/cli/chain.ts` | `npm run chain -- near:deploy-check`, `near:fund-subjects` |
| `apps/warehouse/src/i18n/{en,ha}.ts` | "Stellar network" → a chain name interpolated from config |

### 5.4 Indexer on NEAR (`nearEvents.ts`)

- `getEvents({startLedger, endLedger})` walks **finalized** blocks
  `[start, end]` from neardata. It filters receipt outcomes where
  `executor_id == contractId`, keeps logs that start with `EVENT_JSON:`
  (standard `farmledge_receipt`), and skips failed outcomes.
- Event id = `${height}:${txHash}:${receiptIdx}:${logIdx}`, which is
  deterministic, as `ChainEvent.id` requires.
- `coveredThrough` = last fully scanned height, so **INV-8 gap detection is
  kept**. Page size is a config value (e.g. 50 blocks).
- Fallback if neardata is unavailable: RPC `block` → `chunk` → `tx` status.
  Slower, but it gives the same output.

### 5.5 Config (`src/config/schema.ts`)

```
CHAIN_BACKEND            stellar | near            (default stellar)
NEAR_NETWORK             testnet | mainnet
NEAR_RPC_URL             httpUrl
NEAR_INDEXER_URL         httpUrl   (neardata)
NEAR_CONTRACT_ID         NEAR account id regex
NEAR_CONTRACT_START_BLOCK integer(1)
NEAR_OPERATOR_FUND_YOCTO  bigint string (per-subject top-up)
```

`superRefine`: when `CHAIN_BACKEND=near`, require the `NEAR_*` values and skip
the `STELLAR_*`/`RECEIPT_CONTRACT_ID` requirements. Mirror the existing
"Test SDF" guard: a non-production `FARMLEDGE_ENV` must use `NEAR_NETWORK=testnet`.
Update `.env.example`.

---

## 6. Invariants to re-prove on NEAR

| Invariant | Stellar mechanism | NEAR mechanism |
|---|---|---|
| **INV-1** mint never lands after deadline | tx `max_time` | Contract checks `now_secs ≤ not_after` in `approve_mint`. After `not_after`, the app treats an unlanded mint as settled `expired` once a final block past `not_after` is seen and `tx` lookup shows not found / failed `PendingExpired` |
| **D30** no blind retry | hash recorded first | Same. Tx hash is deterministic before submit |
| **D31** never hold lender key | lender signs auth entry | Lender signs own `offer_lock` tx. No subject kind `lender:` exists (`MANAGED_SUBJECT` unchanged) |
| **INV-2** preclaim | `is_claimed` | Same view |
| **INV-5/7** anchors and proofs | `anchor`, Merkle | Same contract calls, borsh leaf encoding |
| **INV-8** archive has no gaps | RPC `getEvents` retention | Block-height ranges from neardata, gap check unchanged |
| **INV-9** keep-alive | TTL | N/A (`capabilities.ttl = false`), test asserts it's skipped |

---

## 7. Test plan

**Rule:** every changed file gets tests. The existing suite must pass
unchanged under `CHAIN_BACKEND=stellar` before any NEAR code merges.

| Layer | File(s) | Cases |
|---|---|---|
| Port refactor | existing `test/chain/*`, `test/invariants/*` | Green with no assertion changes (proves no behaviour change) |
| Config | `test/config.test.ts` | `near` requires `NEAR_*`; rejects mainnet in non-prod; `stellar` unchanged |
| Migrations | `test/migrations/021_022.test.ts` | See §4 |
| Leaf encoding | `test/domain/merkle.near.test.ts` | Borsh leaf hash equals the **Rust test vectors** (committed JSON from protocol-near); tree/proof roundtrip; Stellar vectors unchanged |
| Addresses | `test/chain/addresses.test.ts` | Implicit id = hex(pubkey); NEAR account validation table (valid, too short, uppercase, 65 chars) |
| NEAR adapter, unit | `test/chain/near/client.test.ts` (mocked RPC with recorded fixtures) | Tx hash computed before submit and recorded; timeout → `resolve` not resend; nonce increments and a concurrent sign is serialised; `E{code}` → `ContractCallError`; `instanceExists` on empty code hash |
| NEAR events | `test/chain/near/events.test.ts` | Parses `EVENT_JSON`, ignores foreign standards and failed outcomes; deterministic ids; `coveredThrough` correct on partial pages |
| Pledge flow | `test/api/pledges.near.test.ts` (fake chain in `near` mode) | `awaiting_lender_offer` → offer tx verified (wrong signer, wrong args, failed tx all rejected) → `accept_lock` → `locked` |
| Invariants | `test/invariants/*` parameterised by backend | INV-1 with contract `not_after`; INV-9 skipped on NEAR |
| Sandbox integration | `test/chain/near/sandbox.test.ts` (`near-sandbox` + built `.wasm` from protocol-near CI artifact) | anchor → propose/approve mint → offer/accept lock → indexer ingests every event → `reconcile()` finds no drift |
| Testnet e2e | `test/testnet/receipt.near.testnet.test.ts` (gated by `NEAR_TESTNET_E2E=1`) | Same flow on testnet; leaf hash vs contract `leaf_hash` view |

**CI (`.github/workflows`)**: matrix `chain: [stellar, near]` for `lint`,
`typecheck`, `test`. Sandbox job downloads the protocol-near wasm artifact.
ESLint `no-restricted-imports` blocks `@stellar/stellar-sdk` outside
`src/chain/{soroban,stellar}*`.

---

## 8. Execution schedule (runs in parallel with protocol-near)

| Day | App track | Depends on |
|---|---|---|
| **0** | Create branch; resolve §2 gate with contract owner; agree borsh `Leaf` layout + test vectors; new DB + `.env` | — |
| **1** | Port refactor (§5.1) with Stellar suite green; config (§5.5); migrations 021/022 + tests | — |
| **2** | `NearChainClient` writes/reads against **mocked RPC**; `nearLeaf.ts` vs vectors; addresses; indexer (§5.4) | Leaf vectors |
| **3** | Pledge flow + lender-offer route; keepAlive/chainDeployment/proofs/i18n; sandbox test against contract wasm | Contract wasm from protocol-near CI |
| **4** | Point to testnet contract; fund subjects; e2e run; deploy hosting from branch; demo script | Testnet deploy |

Freeze at end of Day 3. If the indexer slips, ship with outcome-based ingest
(the app's own txs + the verified lender offer hash) and list INV-8 as a
known gap.

---

## 9. Deployment (hackathon)

- Host from `near-hackathon` with a **dedicated** Postgres (`FARMLEDGE_ENV`
  value distinct from the pilot, so `environmentGuard` refuses cross-use).
- `npm run migrate` → `npm run chain -- near:deploy-check` →
  `npm run chain -- near:fund-subjects` → start.
- Secrets (`KEY_SERVICE_LOCAL_SECRET`, operator key) come from the host's
  secret store. Never commit them, and never reuse pilot secrets.
- Rollback: set `CHAIN_BACKEND=stellar` or `CHAIN_ENABLED=false`. Migrations
  021/022 are inert for Stellar rows.

## 10. Done checklist

- [ ] Stellar suite unchanged and green; NEAR matrix green
- [ ] Migrations 021/022 up/down tested; no edits to 001–020
- [ ] No `@stellar/stellar-sdk` import outside `src/chain/{soroban,stellar}*`
- [ ] Leaf hash matches contract `leaf_hash` on testnet
- [ ] D30/D31/INV-1 tests pass under NEAR
- [ ] End-to-end demo: deposit → anchor → pledge (lender wallet offer) → lock, visible on NearBlocks
