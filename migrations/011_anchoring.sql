-- Up Migration

-- Receipt contract data_version 3: lots, the daily book, anchoring, minting
-- on demand, the event archive and its projections (docs/decisions.md
-- D29-D40). Several rules here are BACKEND-ENFORCED INVARIANTS: the
-- contract cannot check them, so the database is the last line behind
-- them. Each is tagged with its number from the protocol README:
--   INV-1 freshness freeze        INV-2 pre-claim gate
--   INV-3 one lot, one number     INV-4 complete, honest daily books
--   INV-5 anchor daily, in order  INV-6 a minted lot leaves only by exit
--   INV-7 farmer proofs           INV-8 archive before cursor
--   INV-9 keep-alive
-- plus D33: a minted or pledged lot cannot be adjusted or cancelled off-chain.

-- ---------------------------------------------------------------------------
-- INV-3: one lot, one deposit number, forever. Every deposit is a lot. Its
-- number is assigned by this trigger from a per-warehouse counter in the
-- same transaction (so a rolled-back intake consumes nothing and numbers
-- stay contiguous), can never be supplied by a caller, and never changes.
-- ---------------------------------------------------------------------------
CREATE TABLE warehouse_deposit_numbers (
  warehouse_id UUID PRIMARY KEY REFERENCES warehouses (id),
  last_value BIGINT NOT NULL CHECK (last_value > 0),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('warehouse_deposit_numbers');

ALTER TABLE deposits ADD COLUMN deposit_no BIGINT;
UPDATE deposits d SET deposit_no = n.no
  FROM (SELECT id, row_number() OVER (PARTITION BY warehouse_id ORDER BY created_at, id) AS no
          FROM deposits) n
 WHERE n.id = d.id;
INSERT INTO warehouse_deposit_numbers (warehouse_id, last_value)
SELECT warehouse_id, max(deposit_no) FROM deposits GROUP BY warehouse_id;
ALTER TABLE deposits ALTER COLUMN deposit_no SET NOT NULL;
ALTER TABLE deposits ADD CONSTRAINT deposits_deposit_no_positive CHECK (deposit_no > 0);
ALTER TABLE deposits ADD CONSTRAINT deposits_one_number_per_lot UNIQUE (warehouse_id, deposit_no);

CREATE FUNCTION assign_deposit_no() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deposit_no IS NOT NULL THEN
    RAISE EXCEPTION 'deposit_no is assigned by the database, never supplied (INV-3)'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO warehouse_deposit_numbers (warehouse_id, last_value)
  VALUES (NEW.warehouse_id, 1)
  ON CONFLICT (warehouse_id)
    DO UPDATE SET last_value = warehouse_deposit_numbers.last_value + 1
  RETURNING last_value INTO NEW.deposit_no;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assign_deposit_no BEFORE INSERT ON deposits
  FOR EACH ROW EXECUTE FUNCTION assign_deposit_no();

CREATE FUNCTION forbid_deposit_no_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deposit_no IS DISTINCT FROM OLD.deposit_no
     OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id THEN
    RAISE EXCEPTION 'deposit % keeps its number % forever (INV-3)', OLD.deposit_id, OLD.deposit_no
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER forbid_deposit_no_change BEFORE UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION forbid_deposit_no_change();
-- The counter only ever moves up by the trigger above.
CREATE FUNCTION forbid_counter_decrease() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_value <> OLD.last_value + 1 THEN
    RAISE EXCEPTION 'deposit numbers are never reused or skipped (INV-3)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER forbid_counter_decrease BEFORE UPDATE ON warehouse_deposit_numbers
  FOR EACH ROW EXECUTE FUNCTION forbid_counter_decrease();
CREATE TRIGGER warehouse_deposit_numbers_no_delete BEFORE DELETE ON warehouse_deposit_numbers
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Chain transactions: every signed transaction is written here, with its
-- hash and max_time, BEFORE it is submitted, so a crash or timeout is
-- resolved by looking the hash up, never by blind resubmission.
-- ---------------------------------------------------------------------------
CREATE TABLE chain_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('anchor', 'mint', 'lock', 'extend_ttl_batch', 'other')),
  subject TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  envelope_xdr TEXT NOT NULL,
  max_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'signed'
    CHECK (status IN ('signed', 'submitted', 'success', 'failed', 'expired')),
  return_value_xdr TEXT,
  ledger BIGINT,
  error TEXT,
  submitted_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chain_transactions_resolved
    CHECK ((status IN ('success', 'failed', 'expired')) = (resolved_at IS NOT NULL))
);
CALL attach_standard_triggers('chain_transactions');
CREATE INDEX chain_transactions_unresolved_idx ON chain_transactions (status)
  WHERE status IN ('signed', 'submitted');

-- A resolved transaction never changes again.
CREATE FUNCTION freeze_resolved_chain_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('success', 'failed', 'expired') THEN
    RAISE EXCEPTION 'chain transaction % is resolved (%)', OLD.tx_hash, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tx_hash <> OLD.tx_hash OR NEW.envelope_xdr <> OLD.envelope_xdr
     OR NEW.max_time <> OLD.max_time THEN
    RAISE EXCEPTION 'a recorded transaction is immutable; sign a new one'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER freeze_resolved_chain_transaction BEFORE UPDATE ON chain_transactions
  FOR EACH ROW EXECUTE FUNCTION freeze_resolved_chain_transaction();

-- ---------------------------------------------------------------------------
-- Minting and pledges.
-- ---------------------------------------------------------------------------
CREATE TABLE pledges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id TEXT NOT NULL REFERENCES deposits (deposit_id),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  lender_address TEXT NOT NULL CHECK (lender_address ~ '^G[A-Z2-7]{55}$'),
  kg BIGINT NOT NULL CHECK (kg > 0),
  loan_ref TEXT NOT NULL CHECK (octet_length(loan_ref) BETWEEN 1 AND 64),
  due_date TIMESTAMPTZ NOT NULL,
  grace_period_seconds BIGINT NOT NULL CHECK (grace_period_seconds >= 0),
  requested_by UUID NOT NULL,
  verifier_id UUID NOT NULL REFERENCES verifiers (id),
  confirmation_id UUID REFERENCES farmer_confirmations (id),
  status TEXT NOT NULL CHECK (status IN
    ('minting', 'awaiting_lender_signature', 'locking', 'locked', 'failed')),
  receipt_id NUMERIC(20, 0),
  locked_receipt_id NUMERIC(20, 0),
  -- The unsigned authorisation the lender must sign. We never hold a
  -- lender's key; the lender returns the signed entry (D31).
  lender_auth_entry_xdr TEXT,
  lender_auth_valid_until_ledger BIGINT,
  failure TEXT,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (requested_by, warehouse_id) REFERENCES custodians (id, warehouse_id)
);
CALL attach_standard_triggers('pledges');
-- A lot is pledged once; a failed attempt does not count.
CREATE UNIQUE INDEX pledges_one_per_lot_idx ON pledges (deposit_id) WHERE status <> 'failed';

CREATE TABLE mint_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pledge_id UUID REFERENCES pledges (id),
  deposit_id TEXT NOT NULL REFERENCES deposits (deposit_id),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  -- The anchored day whose balance leaf the mint uses.
  anchor_day INTEGER NOT NULL,
  book_entry_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'minted', 'failed')),
  chain_transaction_id UUID REFERENCES chain_transactions (id),
  receipt_id NUMERIC(20, 0),
  failure TEXT,
  resolved_at TIMESTAMPTZ,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mint_requests_minted_has_receipt CHECK ((status = 'minted') = (receipt_id IS NOT NULL))
);
CALL attach_standard_triggers('mint_requests');
CREATE UNIQUE INDEX mint_requests_one_live_per_lot_idx ON mint_requests (deposit_id)
  WHERE status IN ('pending', 'submitted', 'minted');

-- INV-1: the freeze. Set, with the pending mint request, before anything is
-- signed; dispatch refuses while it is set. Cleared only when the mint
-- definitely failed. Once minted it is never cleared: it becomes INV-6.
ALTER TABLE deposits ADD COLUMN frozen_for_mint UUID REFERENCES mint_requests (id);
ALTER TABLE deposits ADD COLUMN chain_receipt_id NUMERIC(20, 0);
ALTER TABLE deposits ADD CONSTRAINT deposits_minted_is_frozen
  CHECK (status <> 'minted' OR (frozen_for_mint IS NOT NULL AND chain_receipt_id IS NOT NULL));

CREATE FUNCTION guard_lot_chain_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- INV-6: a minted lot is governed on-chain forever.
  IF OLD.status = 'minted' AND (NEW.status <> 'minted'
       OR NEW.frozen_for_mint IS DISTINCT FROM OLD.frozen_for_mint
       OR NEW.chain_receipt_id IS DISTINCT FROM OLD.chain_receipt_id) THEN
    RAISE EXCEPTION 'deposit % is minted; it is governed on-chain and leaves only by exit (INV-6)',
      OLD.deposit_id USING ERRCODE = 'check_violation';
  END IF;
  -- INV-1: unfreezing needs the mint request to have definitely failed.
  IF OLD.frozen_for_mint IS NOT NULL AND NEW.frozen_for_mint IS NULL AND NOT EXISTS (
       SELECT 1 FROM mint_requests WHERE id = OLD.frozen_for_mint AND status = 'failed') THEN
    RAISE EXCEPTION 'deposit % stays frozen until its mint has definitely failed (INV-1)',
      OLD.deposit_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_lot_chain_state BEFORE UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION guard_lot_chain_state();

-- ---------------------------------------------------------------------------
-- Which lots each stock movement touched (D29). The stock ledger stays the
-- fungible per-grade balance; this splits every movement across lots, so
-- each lot has a balance and dispatch slips can say which lots were drawn.
-- `book_kg_delta` is the change in the lot's whole-kg book balance
-- (floor of its kg), which is what leaves carry: deposit − dispatches ±
-- adjustments equals the balance leaf exactly, in whole kg.
-- ---------------------------------------------------------------------------
CREATE TABLE lot_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id TEXT NOT NULL REFERENCES deposits (deposit_id),
  stock_movement_id UUID NOT NULL REFERENCES stock_movements (id),
  bags_delta INTEGER NOT NULL,
  kg_delta NUMERIC(12, 2) NOT NULL,
  book_kg_delta BIGINT NOT NULL,
  -- When it entered the books (the app clock); decides which day's tree holds it.
  recorded_at TIMESTAMPTZ NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stock_movement_id, deposit_id),
  CONSTRAINT lot_movements_not_empty CHECK (bags_delta <> 0 OR kg_delta <> 0)
);
CALL attach_standard_triggers('lot_movements');
CALL make_append_only('lot_movements');
CREATE INDEX lot_movements_deposit_idx ON lot_movements (deposit_id, recorded_at);
CREATE INDEX lot_movements_recorded_idx ON lot_movements (recorded_at);

-- The time the current transaction records into the books. Services set it
-- from their clock (`farmledge.recorded_at`); hand-written SQL gets now().
CREATE FUNCTION book_recorded_at() RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('farmledge.recorded_at', true), '')::timestamptz, now())
$$;

-- A warehouse's closed days. A day's tree (leaves, root) is fixed when the
-- day closes, whatever contract it is later anchored on.
CREATE TABLE book_days (
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  day INTEGER NOT NULL CHECK (day > 0),
  status TEXT NOT NULL CHECK (status IN ('built', 'empty')),
  leaves INTEGER CHECK (leaves BETWEEN 1 AND 1048576),
  root BYTEA CHECK (octet_length(root) = 32),
  built_at TIMESTAMPTZ NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, day),
  CONSTRAINT book_days_tree CHECK ((status = 'empty') = (leaves IS NULL AND root IS NULL))
);
CALL attach_standard_triggers('book_days');
CALL make_append_only('book_days');

-- INV-5: days close strictly in order, never skipping one.
CREATE FUNCTION guard_book_day_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_day INTEGER;
BEGIN
  SELECT max(day) INTO last_day FROM book_days WHERE warehouse_id = NEW.warehouse_id;
  IF last_day IS NOT NULL AND NEW.day <> last_day + 1 THEN
    RAISE EXCEPTION 'warehouse % must close day % next, not % (INV-5: never skip a day)',
      NEW.warehouse_id, last_day + 1, NEW.day USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_book_day_order BEFORE INSERT ON book_days
  FOR EACH ROW EXECUTE FUNCTION guard_book_day_order();

-- Anchors, per contract: a Testnet reset starts a fresh chain per
-- warehouse on the new contract, over the same books (README step 8).
-- Written only once the contract's get_anchor returns the head computed
-- here. Never changed.
CREATE TABLE book_anchors (
  contract_id TEXT NOT NULL,
  warehouse_id UUID NOT NULL,
  day INTEGER NOT NULL,
  prev_head BYTEA NOT NULL CHECK (octet_length(prev_head) = 32),
  head BYTEA NOT NULL CHECK (octet_length(head) = 32),
  chain_transaction_id UUID REFERENCES chain_transactions (id),
  anchored_ledger BIGINT NOT NULL,
  anchored_at TIMESTAMPTZ NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, warehouse_id, day),
  FOREIGN KEY (warehouse_id, day) REFERENCES book_days (warehouse_id, day)
);
CALL attach_standard_triggers('book_anchors');
CALL make_append_only('book_anchors');

-- INV-5: anchored strictly in order on each contract, never skipping a
-- day that has a tree, each head chained on the one before.
CREATE FUNCTION guard_book_anchor_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_anchor book_anchors%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM book_days WHERE warehouse_id = NEW.warehouse_id
                    AND day = NEW.day AND status = 'built') THEN
    RAISE EXCEPTION 'day % of warehouse % has no tree to anchor', NEW.day, NEW.warehouse_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO last_anchor FROM book_anchors
   WHERE contract_id = NEW.contract_id AND warehouse_id = NEW.warehouse_id
   ORDER BY day DESC LIMIT 1;
  IF last_anchor.day IS NOT NULL AND NEW.day <= last_anchor.day THEN
    RAISE EXCEPTION 'day % is not after the last anchored day % (INV-5)', NEW.day, last_anchor.day
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.prev_head <> COALESCE(last_anchor.head, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea) THEN
    RAISE EXCEPTION 'anchor for day % does not chain on the previous head (INV-5)', NEW.day
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM book_days b
              WHERE b.warehouse_id = NEW.warehouse_id AND b.status = 'built'
                AND b.day < NEW.day AND b.day > COALESCE(last_anchor.day, 0)) THEN
    RAISE EXCEPTION 'an earlier day of warehouse % is not anchored on % yet (INV-5: never skip)',
      NEW.warehouse_id, NEW.contract_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_book_anchor_order BEFORE INSERT ON book_anchors
  FOR EACH ROW EXECUTE FUNCTION guard_book_anchor_order();

-- Lot balances can't go negative; a lot must match the movement it is part
-- of; nothing is recorded into a closed day (INV-4); and a frozen or
-- minted lot takes no off-chain movement at all (INV-1, INV-6, D33).
CREATE FUNCTION check_lot_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot deposits%ROWTYPE;
  sm stock_movements%ROWTYPE;
  bags BIGINT;
  kg NUMERIC;
  closed_through INTEGER;
BEGIN
  SELECT * INTO lot FROM deposits WHERE deposit_id = NEW.deposit_id FOR UPDATE;
  SELECT * INTO sm FROM stock_movements WHERE id = NEW.stock_movement_id;
  IF (lot.warehouse_id, lot.farmer_id, lot.commodity, lot.grading_scheme, lot.grade)
     IS DISTINCT FROM (sm.warehouse_id, sm.farmer_id, sm.commodity, sm.grading_scheme, sm.grade) THEN
    RAISE EXCEPTION 'lot % is not part of the balance its movement belongs to', NEW.deposit_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF sm.kind <> 'deposit_in' AND (lot.frozen_for_mint IS NOT NULL OR lot.status = 'minted') THEN
    RAISE EXCEPTION 'lot % is % and takes no off-chain movement (INV-1, INV-6, D33)',
      NEW.deposit_id, CASE WHEN lot.status = 'minted' THEN 'minted' ELSE 'frozen for a mint' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'lot_governed_on_chain';
  END IF;
  SELECT max(day) INTO closed_through FROM book_days WHERE warehouse_id = lot.warehouse_id;
  IF closed_through IS NOT NULL
     AND NEW.recorded_at < to_timestamp((closed_through + 1)::bigint * 86400) THEN
    RAISE EXCEPTION 'day % of warehouse % is closed; record at or after its cutoff (INV-4)',
      closed_through, lot.warehouse_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(bags_delta), 0) + NEW.bags_delta, COALESCE(sum(kg_delta), 0) + NEW.kg_delta
    INTO bags, kg FROM lot_movements WHERE deposit_id = NEW.deposit_id;
  IF bags < 0 OR kg < 0 THEN
    RAISE EXCEPTION 'lot % would go negative (% bags, % kg)', NEW.deposit_id, bags, kg
      USING ERRCODE = 'check_violation', CONSTRAINT = 'lot_balance_not_negative';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_lot_movement BEFORE INSERT ON lot_movements
  FOR EACH ROW EXECUTE FUNCTION check_lot_movement();

-- Every stock movement is fully split across lots by the end of its
-- transaction, whatever wrote it.
CREATE FUNCTION check_movement_allocated() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bags BIGINT;
  kg NUMERIC;
BEGIN
  SELECT COALESCE(sum(bags_delta), 0), COALESCE(sum(kg_delta), 0) INTO bags, kg
    FROM lot_movements WHERE stock_movement_id = NEW.id;
  IF bags <> NEW.bags_delta OR kg <> NEW.kg_delta THEN
    RAISE EXCEPTION 'stock movement % (% bags, % kg) is allocated to lots as % bags, % kg',
      NEW.id, NEW.bags_delta, NEW.kg_delta, bags, kg
      USING ERRCODE = 'check_violation', CONSTRAINT = 'movement_allocated_to_lots';
  END IF;
  RETURN NULL;
END;
$$;

-- A lot's whole-kg book balance changes by floor(after) − floor(before).
CREATE FUNCTION lot_book_kg_delta(p_deposit_id TEXT, p_kg_delta NUMERIC) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT (floor(b + p_kg_delta) - floor(b))::BIGINT
    FROM (SELECT COALESCE(sum(kg_delta), 0) AS b FROM lot_movements
           WHERE deposit_id = p_deposit_id) s
$$;

-- Deposits post themselves to the stock ledger AND to their own lot.
CREATE OR REPLACE FUNCTION post_deposit_to_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  movement_id UUID;
  void_kg NUMERIC;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('rejected', 'cancelled') THEN
      INSERT INTO stock_movements (kind, warehouse_id, farmer_id, commodity, grading_scheme,
                                   grade, bags_delta, kg_delta, occurred_at, deposit_id)
      VALUES ('deposit_in', NEW.warehouse_id, NEW.farmer_id, NEW.commodity, NEW.grading_scheme,
              NEW.grade, NEW.bag_count, NEW.estimated_weight_kg, NEW.intake_at, NEW.deposit_id)
      RETURNING id INTO movement_id;
      INSERT INTO lot_movements (deposit_id, stock_movement_id, bags_delta, kg_delta,
                                 book_kg_delta, recorded_at)
      VALUES (NEW.deposit_id, movement_id, NEW.bag_count, NEW.estimated_weight_kg,
              lot_book_kg_delta(NEW.deposit_id, NEW.estimated_weight_kg), book_recorded_at());
    END IF;
  ELSIF NEW.status IN ('rejected', 'cancelled') AND OLD.status NOT IN ('rejected', 'cancelled') THEN
    SELECT NEW.estimated_weight_kg + COALESCE(sum(a.kg_delta), 0) INTO void_kg
      FROM stock_adjustments a WHERE a.deposit_id = NEW.deposit_id;
    INSERT INTO stock_movements (kind, warehouse_id, farmer_id, commodity, grading_scheme,
                                 grade, bags_delta, kg_delta, occurred_at, deposit_id)
    VALUES ('deposit_void', NEW.warehouse_id, NEW.farmer_id, NEW.commodity, NEW.grading_scheme,
            NEW.grade, -NEW.bag_count, -void_kg, NEW.intake_at, NEW.deposit_id)
    RETURNING id INTO movement_id;
    INSERT INTO lot_movements (deposit_id, stock_movement_id, bags_delta, kg_delta,
                               book_kg_delta, recorded_at)
    VALUES (NEW.deposit_id, movement_id, -NEW.bag_count, -void_kg,
            lot_book_kg_delta(NEW.deposit_id, -void_kg), book_recorded_at());
  ELSIF OLD.status IN ('rejected', 'cancelled') AND NEW.status NOT IN ('rejected', 'cancelled') THEN
    RAISE EXCEPTION 'deposit % is % and cannot be reinstated; record a new deposit',
      NEW.deposit_id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

-- D33: a minted or pledged lot cannot be cancelled off-chain. (The lot
-- movement trigger also refuses its void; this names the rule.)
CREATE FUNCTION forbid_cancelling_chain_lot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('rejected', 'cancelled') AND OLD.status NOT IN ('rejected', 'cancelled')
     AND (OLD.frozen_for_mint IS NOT NULL OR OLD.status = 'minted') THEN
    RAISE EXCEPTION 'deposit % is minted or being minted and cannot be cancelled off-chain (D33)',
      OLD.deposit_id USING ERRCODE = 'check_violation', CONSTRAINT = 'lot_governed_on_chain';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER forbid_cancelling_chain_lot BEFORE UPDATE OF status ON deposits
  FOR EACH ROW EXECUTE FUNCTION forbid_cancelling_chain_lot();

-- Backfill: split the movements already recorded across lots, in the order
-- they happened. Deposits and their voids and reweighs go to their own lot;
-- dispatches and other decreases draw from the oldest lots first; other
-- increases go to the newest lot. This is a one-off copy of the rule in
-- src/domain/lots.ts for rows written before lots existed.
DO $$
DECLARE
  m RECORD;
  lot RECORD;
  remaining_bags INTEGER;
  remaining_kg NUMERIC;
  take_bags INTEGER;
  take_kg NUMERIC;
  target TEXT;
BEGIN
  FOR m IN SELECT * FROM stock_movements ORDER BY occurred_at, created_at, id LOOP
    target := NULL;
    IF m.deposit_id IS NOT NULL THEN
      target := m.deposit_id;
    ELSIF m.adjustment_id IS NOT NULL THEN
      SELECT deposit_id INTO target FROM stock_adjustments WHERE id = m.adjustment_id;
    END IF;
    IF target IS NULL AND m.bags_delta >= 0 AND m.kg_delta >= 0 THEN
      SELECT d.deposit_id INTO target FROM deposits d
       WHERE (d.warehouse_id, d.farmer_id, d.commodity, d.grading_scheme, d.grade)
             = (m.warehouse_id, m.farmer_id, m.commodity, m.grading_scheme, m.grade)
         AND d.status NOT IN ('rejected', 'cancelled')
       ORDER BY d.intake_at DESC, d.deposit_no DESC LIMIT 1;
      IF target IS NULL THEN
        RAISE EXCEPTION 'cannot place increase % on a lot', m.id;
      END IF;
    END IF;
    IF target IS NOT NULL THEN
      INSERT INTO lot_movements (deposit_id, stock_movement_id, bags_delta, kg_delta,
                                 book_kg_delta, recorded_at)
      VALUES (target, m.id, m.bags_delta, m.kg_delta, lot_book_kg_delta(target, m.kg_delta),
              m.created_at);
      CONTINUE;
    END IF;
    remaining_bags := -m.bags_delta;
    remaining_kg := -m.kg_delta;
    FOR lot IN
      SELECT d.deposit_id, COALESCE(sum(l.bags_delta), 0) AS bags,
             COALESCE(sum(l.kg_delta), 0) AS kg
        FROM deposits d LEFT JOIN lot_movements l ON l.deposit_id = d.deposit_id
       WHERE (d.warehouse_id, d.farmer_id, d.commodity, d.grading_scheme, d.grade)
             = (m.warehouse_id, m.farmer_id, m.commodity, m.grading_scheme, m.grade)
       GROUP BY d.deposit_id, d.intake_at, d.deposit_no
      HAVING COALESCE(sum(l.bags_delta), 0) > 0 OR COALESCE(sum(l.kg_delta), 0) > 0
       ORDER BY d.intake_at, d.deposit_no
    LOOP
      EXIT WHEN remaining_bags <= 0 AND remaining_kg <= 0;
      take_bags := LEAST(lot.bags, remaining_bags);
      take_kg := CASE WHEN remaining_kg <= 0 THEN 0
                      WHEN take_bags >= lot.bags OR remaining_bags <= take_bags
                      THEN LEAST(lot.kg, remaining_kg)
                      ELSE LEAST(round(lot.kg * take_bags / lot.bags, 2), remaining_kg) END;
      IF take_bags > 0 OR take_kg > 0 THEN
        INSERT INTO lot_movements (deposit_id, stock_movement_id, bags_delta, kg_delta,
                                   book_kg_delta, recorded_at)
        VALUES (lot.deposit_id, m.id, -take_bags, -take_kg,
                lot_book_kg_delta(lot.deposit_id, -take_kg), m.created_at);
        remaining_bags := remaining_bags - take_bags;
        remaining_kg := remaining_kg - take_kg;
      END IF;
    END LOOP;
    IF remaining_bags <> 0 OR remaining_kg <> 0 THEN
      RAISE EXCEPTION 'cannot split movement % across lots (% bags, % kg left)',
        m.id, remaining_bags, remaining_kg;
    END IF;
  END LOOP;
END;
$$;

-- Created after the backfill so it checks only new movements.
CREATE CONSTRAINT TRIGGER check_movement_allocated AFTER INSERT ON stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_movement_allocated();

-- A dispatch or adjustment may name the lot it takes from (D29).
ALTER TABLE dispatches ADD COLUMN requested_deposit_id TEXT REFERENCES deposits (deposit_id);
ALTER TABLE stock_adjustments ADD COLUMN requested_deposit_id TEXT REFERENCES deposits (deposit_id);

-- ---------------------------------------------------------------------------
-- INV-4: the daily book. One entry per lot movement (a deposit, dispatch,
-- adjustment or cancellation), plus a balance leaf per active lot when a
-- day closes. Deposit, dispatch and balance entries are contract `Leaf`s;
-- adjustments and cancellations are book records with their own hashes,
-- committed in the same tree (D32). Each has a fresh random salt, stored
-- once and never reused. Content and salt never change; day, index, hash
-- and proof are written once, when the day's tree is built.
-- ---------------------------------------------------------------------------
CREATE TABLE book_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('leaf', 'record')),
  -- Leaf kind: 0 deposit, 1 dispatch, 2 balance. Null for records.
  kind SMALLINT CHECK (kind IN (0, 1, 2)),
  record_kind TEXT CHECK (record_kind IN ('adjustment', 'cancellation')),
  deposit_id TEXT NOT NULL REFERENCES deposits (deposit_id),
  deposit_no BIGINT NOT NULL,
  farmer_id UUID NOT NULL REFERENCES farmers (id),
  lot_movement_id UUID UNIQUE REFERENCES lot_movements (id),
  -- Every field except day, index and salt, as the leaf's JSON form.
  content JSONB NOT NULL,
  salt BYTEA NOT NULL UNIQUE CHECK (octet_length(salt) = 32),
  recorded_at TIMESTAMPTZ NOT NULL,
  day INTEGER,
  idx INTEGER CHECK (idx >= 0),
  leaf_hash BYTEA UNIQUE CHECK (octet_length(leaf_hash) = 32),
  -- Sibling hashes from the leaf to the root, hex.
  proof JSONB,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, day, idx),
  CONSTRAINT book_entries_type CHECK (
    (entry_type = 'leaf' AND kind IS NOT NULL AND record_kind IS NULL)
    OR (entry_type = 'record' AND kind IS NULL AND record_kind IS NOT NULL)),
  CONSTRAINT book_entries_movement CHECK ((kind = 2) = (lot_movement_id IS NULL)),
  CONSTRAINT book_entries_placed CHECK (
    (day IS NULL AND idx IS NULL AND leaf_hash IS NULL AND proof IS NULL)
    OR (day IS NOT NULL AND idx IS NOT NULL AND leaf_hash IS NOT NULL AND proof IS NOT NULL))
);
CALL attach_standard_triggers('book_entries');
CREATE INDEX book_entries_unplaced_idx ON book_entries (warehouse_id, recorded_at) WHERE day IS NULL;
CREATE INDEX book_entries_lot_idx ON book_entries (deposit_id, day);
CREATE INDEX book_entries_farmer_idx ON book_entries (farmer_id, day);
-- One balance leaf per lot per day.
CREATE UNIQUE INDEX book_entries_one_balance_idx ON book_entries (deposit_id, day) WHERE kind = 2;

CREATE FUNCTION guard_book_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'book entries are never deleted (INV-4)' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.content, NEW.salt, NEW.warehouse_id, NEW.entry_type, NEW.kind, NEW.record_kind,
      NEW.deposit_id, NEW.deposit_no, NEW.lot_movement_id, NEW.recorded_at)
     IS DISTINCT FROM
     (OLD.content, OLD.salt, OLD.warehouse_id, OLD.entry_type, OLD.kind, OLD.record_kind,
      OLD.deposit_id, OLD.deposit_no, OLD.lot_movement_id, OLD.recorded_at)
     OR (OLD.day IS NOT NULL AND (NEW.day, NEW.idx, NEW.leaf_hash, NEW.proof)
                                 IS DISTINCT FROM (OLD.day, OLD.idx, OLD.leaf_hash, OLD.proof)) THEN
    RAISE EXCEPTION 'book entry % is immutable once written and once placed (INV-4)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_book_entry BEFORE UPDATE OR DELETE ON book_entries
  FOR EACH ROW EXECUTE FUNCTION guard_book_entry();

-- ---------------------------------------------------------------------------
-- INV-2: the pre-claim gate. No mint for a warehouse unless its gate row
-- says the pre-claim is verified, or that none is needed because the
-- deployment has no predecessor holding real lots. No row: no mint.
-- ---------------------------------------------------------------------------
CREATE TABLE chain_deployments (
  contract_id TEXT PRIMARY KEY CHECK (contract_id ~ '^C[A-Z2-7]{55}$'),
  network_passphrase TEXT NOT NULL,
  rpc_url TEXT NOT NULL,
  start_ledger BIGINT NOT NULL CHECK (start_ledger > 0),
  -- An older contract holding real lots, whose lots must be pre-claimed
  -- here before anything mints (INV-2). Null on Testnet and mainnet v3.
  predecessor_contract_id TEXT CHECK (predecessor_contract_id ~ '^C[A-Z2-7]{55}$'),
  status TEXT NOT NULL CHECK (status IN ('current', 'retired')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  retired_reason TEXT,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chain_deployments_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
CALL attach_standard_triggers('chain_deployments');
CREATE UNIQUE INDEX chain_deployments_one_current_idx ON chain_deployments ((true))
  WHERE status = 'current';

CREATE TABLE preclaim_gates (
  contract_id TEXT NOT NULL REFERENCES chain_deployments (contract_id),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  status TEXT NOT NULL CHECK (status IN ('not_required', 'pending', 'verified')),
  -- The deposit numbers to pre-claim, once built from the old contract.
  deposit_nos BIGINT[],
  verified_at TIMESTAMPTZ,
  verified_by TEXT,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, warehouse_id),
  CONSTRAINT preclaim_gates_verified
    CHECK ((status = 'verified') = (verified_at IS NOT NULL AND verified_by IS NOT NULL))
);
CALL attach_standard_triggers('preclaim_gates');

-- 'not_required' only where the deployment has no predecessor.
CREATE FUNCTION check_preclaim_gate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'not_required' AND EXISTS (
       SELECT 1 FROM chain_deployments
        WHERE contract_id = NEW.contract_id AND predecessor_contract_id IS NOT NULL) THEN
    RAISE EXCEPTION 'contract % has a predecessor: its pre-claim must be verified (INV-2)',
      NEW.contract_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_preclaim_gate BEFORE INSERT OR UPDATE ON preclaim_gates
  FOR EACH ROW EXECUTE FUNCTION check_preclaim_gate();

-- ---------------------------------------------------------------------------
-- INV-8: the event archive. Every event is written (raw XDR, ledger,
-- transaction hash, event index) before the cursor moves, idempotently on
-- (ledger, tx hash, event index), and never pruned or changed.
-- ---------------------------------------------------------------------------
ALTER TABLE events_archive ADD COLUMN tx_index INTEGER NOT NULL;
ALTER TABLE events_archive ADD COLUMN op_index INTEGER NOT NULL;
ALTER TABLE events_archive ADD COLUMN event_index INTEGER NOT NULL;
ALTER TABLE events_archive ADD COLUMN topic_xdr TEXT[] NOT NULL;
ALTER TABLE events_archive ADD COLUMN value_xdr TEXT NOT NULL;
ALTER TABLE events_archive ADD COLUMN in_successful_contract_call BOOLEAN NOT NULL;
ALTER TABLE events_archive
  ADD CONSTRAINT events_archive_identity UNIQUE (ledger, tx_hash, event_index);
CREATE INDEX events_archive_type_idx ON events_archive (contract_id, event_type);
CALL make_append_only('events_archive');

CREATE TABLE indexer_cursors (
  contract_id TEXT PRIMARY KEY,
  start_ledger BIGINT NOT NULL CHECK (start_ledger > 0),
  -- Every ledger from start_ledger through this one is archived.
  cursor_ledger BIGINT NOT NULL,
  latest_network_ledger BIGINT,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cursor_ledger >= start_ledger - 1)
);
CALL attach_standard_triggers('indexer_cursors');

-- The ledger ranges actually fetched and archived, so gaps can be found.
CREATE TABLE indexed_ranges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id TEXT NOT NULL,
  from_ledger BIGINT NOT NULL,
  to_ledger BIGINT NOT NULL,
  event_count INTEGER NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_ledger <= to_ledger)
);
CALL attach_standard_triggers('indexed_ranges');
CALL make_append_only('indexed_ranges');
CREATE INDEX indexed_ranges_contract_idx ON indexed_ranges (contract_id, from_ledger);

-- Projections: derived only from the archive, rebuilt from it at will.
CREATE TABLE chain_receipts (
  contract_id TEXT NOT NULL,
  receipt_id NUMERIC(20, 0) NOT NULL,
  parent_id NUMERIC(20, 0),
  warehouse_symbol TEXT NOT NULL,
  deposit_no NUMERIC(20, 0) NOT NULL,
  deposit_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Active', 'Locked', 'Recovery', 'Exited', 'Revoked')),
  weight_kg NUMERIC(20, 0) NOT NULL,
  bag_count BIGINT NOT NULL,
  -- minted weight, or the taken weight for a receipt split off another.
  initial_weight_kg NUMERIC(20, 0) NOT NULL,
  weight_source TEXT NOT NULL,
  lender TEXT,
  loan_ref TEXT,
  anchor_day INTEGER,
  leaf_hash TEXT,
  minted_ledger BIGINT,
  minted_at BIGINT,
  last_event_ledger BIGINT NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, receipt_id)
);
CALL attach_standard_triggers('chain_receipts');
CREATE INDEX chain_receipts_lot_idx ON chain_receipts (contract_id, warehouse_symbol, deposit_no);

CREATE TABLE chain_anchors (
  contract_id TEXT NOT NULL,
  warehouse_symbol TEXT NOT NULL,
  day INTEGER NOT NULL,
  leaves INTEGER NOT NULL,
  root TEXT NOT NULL,
  prev_head TEXT NOT NULL,
  head TEXT NOT NULL,
  custodian TEXT NOT NULL,
  anchored_at BIGINT NOT NULL,
  ledger BIGINT NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, warehouse_symbol, day)
);
CALL attach_standard_triggers('chain_anchors');

CREATE TABLE chain_registry (
  contract_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('warehouse', 'custodian', 'verifier', 'recovery_operator')),
  warehouse_symbol TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL,
  last_event_ledger BIGINT NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, role, warehouse_symbol, address)
);
CALL attach_standard_triggers('chain_registry');

-- ---------------------------------------------------------------------------
-- Alerts: pages and warnings raised by jobs and checks. One open row per
-- key; a repeat bumps it.
-- ---------------------------------------------------------------------------
CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'page', 'urgent')),
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  first_raised_at TIMESTAMPTZ NOT NULL,
  last_raised_at TIMESTAMPTZ NOT NULL,
  raise_count INTEGER NOT NULL DEFAULT 1,
  resolved_at TIMESTAMPTZ,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('alerts');
CREATE UNIQUE INDEX alerts_one_open_idx ON alerts (alert_key) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- INV-7: proof delivery. One row per bundle handed to a farmer, with the
-- public token its link carries and a delivery receipt.
-- ---------------------------------------------------------------------------
CREATE TABLE proof_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_entry_id UUID NOT NULL REFERENCES book_entries (id),
  farmer_id UUID NOT NULL REFERENCES farmers (id),
  reason TEXT NOT NULL CHECK (reason IN ('anchored', 'statement')),
  -- Unguessable; the link to the bundle carries it.
  token TEXT NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{22,}$'),
  -- The bundle exactly as delivered.
  bundle JSONB NOT NULL,
  notification_id UUID REFERENCES notifications (id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  statement_id UUID,
  contract_id TEXT NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('proof_deliveries');
CREATE UNIQUE INDEX proof_deliveries_one_anchored_idx ON proof_deliveries (contract_id, book_entry_id)
  WHERE reason = 'anchored';
CREATE INDEX proof_deliveries_status_idx ON proof_deliveries (status) WHERE status <> 'sent';

CREATE TABLE farmer_statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id UUID NOT NULL REFERENCES farmers (id),
  warehouse_id UUID NOT NULL REFERENCES warehouses (id),
  day INTEGER NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{22,}$'),
  contract_id TEXT NOT NULL,
  notification_id UUID REFERENCES notifications (id),
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (farmer_id, warehouse_id, day)
);
CALL attach_standard_triggers('farmer_statements');

-- INV-9: keep-alive runs and what they sent.
CREATE TABLE keepalive_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id TEXT NOT NULL,
  receipt_ids NUMERIC(20, 0)[] NOT NULL,
  skipped_finished INTEGER NOT NULL,
  batches INTEGER NOT NULL,
  min_days_remaining NUMERIC(10, 2),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  environment farmledge_environment NOT NULL DEFAULT current_db_environment(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CALL attach_standard_triggers('keepalive_runs');

-- Down Migration

DROP TABLE keepalive_runs;
DROP TABLE farmer_statements;
DROP TABLE proof_deliveries;
DROP TABLE alerts;
DROP TABLE chain_registry;
DROP TABLE chain_anchors;
DROP TABLE chain_receipts;
DROP TABLE indexed_ranges;
DROP TABLE indexer_cursors;
DROP TRIGGER append_only ON events_archive;
DROP TRIGGER append_only_no_truncate ON events_archive;
DROP INDEX events_archive_type_idx;
ALTER TABLE events_archive DROP CONSTRAINT events_archive_identity;
ALTER TABLE events_archive DROP COLUMN in_successful_contract_call;
ALTER TABLE events_archive DROP COLUMN value_xdr;
ALTER TABLE events_archive DROP COLUMN topic_xdr;
ALTER TABLE events_archive DROP COLUMN event_index;
ALTER TABLE events_archive DROP COLUMN op_index;
ALTER TABLE events_archive DROP COLUMN tx_index;
DROP TABLE preclaim_gates;
DROP FUNCTION check_preclaim_gate();
DROP TABLE chain_deployments;
DROP TABLE book_entries;
DROP FUNCTION guard_book_entry();
ALTER TABLE stock_adjustments DROP COLUMN requested_deposit_id;
ALTER TABLE dispatches DROP COLUMN requested_deposit_id;
DROP TRIGGER forbid_cancelling_chain_lot ON deposits;
DROP FUNCTION forbid_cancelling_chain_lot();
DROP TRIGGER check_movement_allocated ON stock_movements;
DROP FUNCTION check_movement_allocated();

CREATE OR REPLACE FUNCTION post_deposit_to_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('rejected', 'cancelled') THEN
      INSERT INTO stock_movements (kind, warehouse_id, farmer_id, commodity, grading_scheme,
                                   grade, bags_delta, kg_delta, occurred_at, deposit_id)
      VALUES ('deposit_in', NEW.warehouse_id, NEW.farmer_id, NEW.commodity, NEW.grading_scheme,
              NEW.grade, NEW.bag_count, NEW.estimated_weight_kg, NEW.intake_at, NEW.deposit_id);
    END IF;
  ELSIF NEW.status IN ('rejected', 'cancelled') AND OLD.status NOT IN ('rejected', 'cancelled') THEN
    INSERT INTO stock_movements (kind, warehouse_id, farmer_id, commodity, grading_scheme,
                                 grade, bags_delta, kg_delta, occurred_at, deposit_id)
    SELECT 'deposit_void', NEW.warehouse_id, NEW.farmer_id, NEW.commodity, NEW.grading_scheme,
           NEW.grade, -NEW.bag_count,
           -(NEW.estimated_weight_kg + COALESCE(sum(a.kg_delta), 0)), NEW.intake_at,
           NEW.deposit_id
      FROM stock_adjustments a WHERE a.deposit_id = NEW.deposit_id;
  ELSIF OLD.status IN ('rejected', 'cancelled') AND NEW.status NOT IN ('rejected', 'cancelled') THEN
    RAISE EXCEPTION 'deposit % is % and cannot be reinstated; record a new deposit',
      NEW.deposit_id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TABLE lot_movements;
DROP FUNCTION check_lot_movement();
DROP FUNCTION lot_book_kg_delta(TEXT, NUMERIC);
DROP TABLE book_anchors;
DROP FUNCTION guard_book_anchor_order();
DROP TABLE book_days;
DROP FUNCTION guard_book_day_order();
DROP FUNCTION book_recorded_at();
DROP TRIGGER guard_lot_chain_state ON deposits;
DROP FUNCTION guard_lot_chain_state();
ALTER TABLE deposits DROP CONSTRAINT deposits_minted_is_frozen;
ALTER TABLE deposits DROP COLUMN chain_receipt_id;
ALTER TABLE deposits DROP COLUMN frozen_for_mint;
DROP TABLE mint_requests;
DROP TABLE pledges;
DROP TABLE chain_transactions;
DROP FUNCTION freeze_resolved_chain_transaction();
DROP TRIGGER warehouse_deposit_numbers_no_delete ON warehouse_deposit_numbers;
DROP TRIGGER forbid_counter_decrease ON warehouse_deposit_numbers;
DROP FUNCTION forbid_counter_decrease();
DROP TRIGGER forbid_deposit_no_change ON deposits;
DROP FUNCTION forbid_deposit_no_change();
DROP TRIGGER assign_deposit_no ON deposits;
DROP FUNCTION assign_deposit_no();
ALTER TABLE deposits DROP CONSTRAINT deposits_one_number_per_lot;
ALTER TABLE deposits DROP CONSTRAINT deposits_deposit_no_positive;
ALTER TABLE deposits DROP COLUMN deposit_no;
DROP TABLE warehouse_deposit_numbers;
