# Architecture: ports and adapters

This note is for whoever extends the backend next. The aim is that every
open decision (`docs/decisions.md`, provisions a–i) is **one swap**: write
an adapter, add a config value, change one factory. No service changes, and
no refactor.

## Layers

```
http/routes  →  services  →  domain
                   ↓
                 ports  ←  adapters (picked in src/adapters.ts)
                   ↓
                Postgres
```

| Layer              | What lives there                                                                                                                       | May depend on             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `src/domain/`      | Pure rules and arithmetic: validation, ledger sums, fee accrual, statements, grading, weight policy                                    | config types only; no I/O |
| `src/services/`    | One class per area: loads rows, calls domain rules, writes in transactions, returns API views                                          | domain, ports, `db/`      |
| `src/http/`        | Request shape (`parse.ts`), routes, error mapping                                                                                      | services                  |
| ports (interfaces) | `ChainClient`, `KeyService`, `SmsGateway`, `FarmerConfirmation`, `LendingService`, `PricingProvider`, `PhotoStore`, `PlatformFeeModel` | nothing                   |
| adapters           | Implementations of a port                                                                                                              | the port, `db/`, Node     |
| `src/adapters.ts`  | **The only place** an adapter is chosen from config                                                                                    | everything above          |

Rules of thumb:

- **Services never read the flags that choose adapters.** They receive a
  port. `DispatchService` calls `confirmation.request(...)`; it doesn't know
  whether that is a tablet tick or a two-way SMS.
- **Business rules go in `domain/`**, so they are unit-tested without a
  database. If a test needs Postgres to check arithmetic, the arithmetic is
  in the wrong place.
- **Each port takes the caller's transaction when it writes**
  (`ChainClient`, `FarmerConfirmation`, `NotificationService.queue`), so a
  side effect is recorded exactly when the change that caused it commits.
- **An unavailable adapter fails early.** `createAdapters` throws
  `AdapterUnavailableError` at startup, and a route that needs a stub
  answers 501, rather than failing halfway through a deposit.

## The ports

| Port                 | Folder              | Adapters now                                                                         | Selected by                        |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- |
| `ChainClient`        | `src/chain/`        | `NoopChainClient` (writes `chain_intents`); `SorobanChainClient` stub                | `CHAIN_ENABLED`                    |
| `KeyService`         | `src/keys/`         | `LocalDevKeyService` (HKDF-derived Ed25519, signatures logged); `KmsKeyService` stub | `KEY_SERVICE`                      |
| `SmsGateway`         | `src/sms/`          | `MockSmsGateway` (logs)                                                              | `SMS_GATEWAY`                      |
| `FarmerConfirmation` | `src/confirmation/` | `TabletConfirmation`; `SmsTwoWayConfirmation` stub (501)                             | `CONFIRMATION_MODE`                |
| `LendingService`     | `src/lending/`      | `NotImplementedLendingService` (501)                                                 | `LENDING_ENABLED` gates the routes |
| `PricingProvider`    | `src/pricing/`      | `ManualPriceProvider` (`manual_prices`)                                              | `PRICING_PROVIDER`                 |
| `PhotoStore`         | `src/storage/`      | `LocalDiskPhotoStore`                                                                | `server.ts`                        |
| `PlatformFeeModel`   | `src/platformFees/` | `none`, `per_bag`; `revenue_share`, `subscription` stubs                             | per-warehouse terms (database)     |

Two policies are config read by domain functions rather than ports, because
they are rules, not integrations:

- grading scheme: `src/domain/grading.ts` (`GRADING_SCHEME`, `GRADE_VALUES`);
- weight policy: `src/domain/weightPolicy.ts` (`WEIGHT_MODE`; the pledge rule
  `assertPledgeable`).

## Adding an adapter: worked example (a real SMS provider)

1. Write `src/sms/termiiSmsGateway.ts` implementing `SmsGateway`
   (`provider`, `send`). Throw on a provider error; `NotificationService`
   marks the row `failed` and the request that caused it still succeeds.
2. Add the value to `SMS_GATEWAY` in `src/config/schema.ts`, plus any
   credentials it needs (required, no defaults), and to `.env.example`.
3. In `src/adapters.ts`, return the new gateway when it is selected.
4. Test the adapter on its own; the services' tests don't change.

The same four steps apply to every port. For the chain: implement
`SorobanChainClient`, return it from `createChainClient` when
`CHAIN_ENABLED=true`, and stop throwing there.

## How data flows: a dispatch

1. `routes/dispatches.ts` checks the JSON shape.
2. `DispatchService` validates (`domain/ledger.ts`), checks references, then
   in one transaction: asks `FarmerConfirmation`, locks the balance and
   checks it (`lockedBalance`), numbers the delivery note, inserts the
   dispatch and its `dispatch_out` ledger row, records the exit intent
   through `ChainClient`, and queues the SMS.
3. After commit, `NotificationService.deliver` sends the SMS through
   `SmsGateway`.

The database backs every invariant the services rely on: the ledger and
fee tables are append-only, a balance can't go negative, deposits post
themselves to the ledger, and every row carries the environment marker.
Hand-written SQL can't break them either.

## Jobs

`src/cli/` holds the entry points that run outside the API:
`migrate.ts` and `accrueFees.ts` (`npm run accrue-fees`, daily from cron).
They build config, check the database environment, and call the same
services as the API.
