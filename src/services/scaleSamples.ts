import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { Commodity, Config } from '../config/index.js';
import type { Queryable } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { domainError } from '../domain/errors.js';
import { isUuid } from '../domain/ids.js';
import { fromCentiKg, roundHalfAway, toCentiKg } from '../domain/quantities.js';
import {
  summariseScaleSamples,
  validateScaleSample,
  type ScaleSampleDraft,
  type ScaleSummary,
} from '../domain/scale.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import type { KeyService } from '../keys/keyService.js';
import { lockedLots, openBookWrite } from './book.js';
import { lockedBalance, postAdjustment } from './ledger.js';
import { checkReferences } from './references.js';

export interface ScaleSampleInput extends ScaleSampleDraft {
  readonly recordedBy: string;
  /** Tablet-generated idempotency key (D42); optional for older clients. */
  readonly sampleId?: string | undefined;
}

export interface ScaleSampleOutcome {
  /** `duplicate`: this sample_id was already recorded with the same content. */
  kind: 'created' | 'duplicate';
  sample: ScaleSampleView;
}

export interface ScaleSampleView {
  id: string;
  /** The tablet's idempotency key; null for samples recorded without one. */
  sample_id: string | null;
  deposit_id: string;
  bags_weighed: number;
  total_kg: number;
  kg_per_bag: number;
  recorded_by: string;
  recorded_at: Date;
}

interface SampleRow {
  id: string;
  sample_id: string | null;
  deposit_id: string;
  bags_weighed: number;
  total_kg: string;
  recorded_by: string;
  recorded_at: Date;
}

export interface ScaleSummaryFilter {
  commodity?: Commodity | undefined;
  from?: Date | undefined;
  /** Exclusive. */
  to?: Date | undefined;
}

export class ScaleSampleService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
    private readonly keys: KeyService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Stores a scale reading against a deposit. Readings are kept apart from
   * the deposit: a bag-estimate deposit's weight_kg never changes.
   */
  async record(depositId: string, input: ScaleSampleInput): Promise<ScaleSampleOutcome> {
    const validated = validateScaleSample(
      input,
      this.config.intake.offlineRejectAfterHours,
      this.clock(),
    );
    const sampleId = input.sampleId?.toLowerCase();
    const errors = validated.ok ? [] : [...validated.errors];
    if (sampleId !== undefined && !isUuid(sampleId)) {
      errors.push(
        domainError(
          'invalid_sample_id',
          'sample_id',
          'sample_id must be a UUID generated on the tablet',
        ),
      );
    }
    if (!validated.ok || errors.length > 0) {
      throw new ValidationError('Scale sample is invalid', { details: errors });
    }
    const sample = validated.value;

    // A repeat is answered from what was stored, before any rule that the
    // first submission itself changed (bags already weighed), so retries converge.
    if (sampleId !== undefined) {
      const repeat = await this.repeatOutcome(depositId, sampleId, input, sample.totalCentiKg);
      if (repeat !== null) return repeat;
    }

    return withTransaction(this.pool, async (client) => {
      const located = await client.query<{ warehouse_id: string }>(
        'SELECT warehouse_id FROM deposits WHERE deposit_id = $1',
        [depositId.toLowerCase()],
      );
      if (located.rows[0] !== undefined) {
        await openBookWrite(client, located.rows[0].warehouse_id, this.clock());
      }
      // Lock the deposit so concurrent samples are checked one at a time.
      const deposit = await client.query<DepositForSample>(
        `SELECT warehouse_id, farmer_id, verifier_id, commodity, grading_scheme, grade, bag_count,
                estimated_weight_kg, weight_source, status
         FROM deposits WHERE deposit_id = $1 FOR UPDATE`,
        [depositId.toLowerCase()],
      );
      const found = deposit.rows[0];
      if (found === undefined) throw new NotFoundError('Deposit not found');

      // The deposit row lock just taken serialises samples of one deposit, so a
      // concurrent repeat of this sample_id is seen here, not as a conflict.
      if (sampleId !== undefined) {
        const repeat = await this.repeatOutcome(
          depositId,
          sampleId,
          input,
          sample.totalCentiKg,
          client,
        );
        if (repeat !== null) return repeat;
      }

      const referenceErrors = await checkReferences(client, {
        warehouse: { id: found.warehouse_id, field: 'warehouse_id', mustBeActive: false },
        custodian: { id: input.recordedBy, field: 'recorded_by' },
      });
      if (referenceErrors.length > 0) {
        throw new ValidationError('Scale sample is invalid', { details: referenceErrors });
      }

      const weighed = await client.query<{ bags: string }>(
        'SELECT COALESCE(sum(bags_weighed), 0) AS bags FROM scale_samples WHERE deposit_id = $1',
        [depositId.toLowerCase()],
      );
      const alreadyWeighed = Number(weighed.rows[0]?.bags ?? 0);
      if (alreadyWeighed + sample.bagsWeighed > found.bag_count) {
        throw new ConflictError(
          `Samples would cover ${alreadyWeighed + sample.bagsWeighed} bags but the deposit has ${found.bag_count}`,
          {
            code: 'scale_samples_exceed_bags',
            details: { bag_count: found.bag_count, bags_already_weighed: alreadyWeighed },
          },
        );
      }

      const { rows } = await client.query<SampleRow>(
        `INSERT INTO scale_samples
           (sample_id, deposit_id, bags_weighed, total_kg, recorded_by, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${SAMPLE_COLUMNS}`,
        [
          sampleId ?? null,
          depositId.toLowerCase(),
          sample.bagsWeighed,
          (sample.totalCentiKg / 100).toFixed(2),
          input.recordedBy,
          sample.recordedAt ?? this.clock(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('scale sample insert returned no row');

      if (alreadyWeighed + sample.bagsWeighed === found.bag_count) {
        await postReweigh(
          client,
          depositId.toLowerCase(),
          found,
          input.recordedBy,
          this.clock(),
          this.keys,
          this.config.chain.backend,
        );
      }
      return { kind: 'created' as const, sample: toView(row) };
    });
  }

  /**
   * The stored sample when `sampleId` was already recorded: `duplicate` if
   * the content matches, a 409 `sample_id_conflict` if not. Null when new.
   * `recorded_at` is not compared, as `captured_at` isn't for deposits.
   */
  private async repeatOutcome(
    depositId: string,
    sampleId: string,
    input: ScaleSampleInput,
    totalCentiKg: number,
    db: Queryable = this.pool,
  ): Promise<ScaleSampleOutcome | null> {
    const { rows } = await db.query<SampleRow>(
      `SELECT ${SAMPLE_COLUMNS} FROM scale_samples WHERE sample_id = $1`,
      [sampleId],
    );
    const stored = rows[0];
    if (stored === undefined) return null;
    const differing = [
      stored.deposit_id !== depositId.toLowerCase() && 'deposit_id',
      stored.bags_weighed !== input.bagsWeighed && 'bags_weighed',
      toCentiKg(stored.total_kg) !== totalCentiKg && 'total_kg',
      stored.recorded_by !== input.recordedBy.toLowerCase() && 'recorded_by',
    ].filter((field) => field !== false);
    if (differing.length > 0) {
      throw new ConflictError('This sample_id was already used for a different sample', {
        code: 'sample_id_conflict',
        details: { differing_fields: differing },
      });
    }
    return { kind: 'duplicate', sample: toView(stored) };
  }

  /** Average measured kg per bag against the bag size assumed at intake, for one warehouse. */
  async warehouseSummary(warehouseId: string, filter: ScaleSummaryFilter): Promise<ScaleSummary> {
    const warehouse = await this.pool.query('SELECT 1 FROM warehouses WHERE id = $1', [
      warehouseId,
    ]);
    if (warehouse.rowCount === 0) throw new NotFoundError('Warehouse not found');

    const { rows } = await this.pool.query<{
      sample_count: number;
      bags_weighed: string | null;
      total_kg: string | null;
      nominal_kg: string | null;
    }>(
      `SELECT count(*)::int AS sample_count,
              sum(s.bags_weighed) AS bags_weighed,
              sum(s.total_kg) AS total_kg,
              sum(s.bags_weighed::bigint * d.bag_size_kg) AS nominal_kg
       FROM scale_samples s
       JOIN deposits d USING (deposit_id)
       WHERE d.warehouse_id = $1
         AND ($2::text IS NULL OR d.commodity = $2)
         AND ($3::timestamptz IS NULL OR s.recorded_at >= $3)
         AND ($4::timestamptz IS NULL OR s.recorded_at < $4)`,
      [warehouseId, filter.commodity ?? null, filter.from ?? null, filter.to ?? null],
    );
    const row = rows[0];
    return summariseScaleSamples({
      sampleCount: row?.sample_count ?? 0,
      bagsWeighed: Number(row?.bags_weighed ?? 0),
      totalCentiKg: toCentiKg(row?.total_kg ?? 0),
      nominalKg: Number(row?.nominal_kg ?? 0),
    });
  }
}

interface DepositForSample {
  warehouse_id: string;
  farmer_id: string;
  verifier_id: string;
  commodity: string;
  grading_scheme: string;
  grade: string;
  bag_count: number;
  estimated_weight_kg: string;
  weight_source: string;
  status: string;
}

/**
 * Once every bag of a scale-weighed deposit (WEIGHT_MODE=scale_required) is
 * weighed, the ledger moves from the bag estimate to the measured weight by
 * a `scale_reweigh` adjustment, authorised by the deposit's verifier.
 * Bag-estimate deposits are never reweighed (D7).
 */
async function postReweigh(
  client: pg.PoolClient,
  depositId: string,
  deposit: DepositForSample,
  recordedBy: string,
  now: Date,
  keys: KeyService,
  backend: Config['chain']['backend'] = 'stellar',
): Promise<void> {
  if (deposit.weight_source !== 'scale' || ['rejected', 'cancelled'].includes(deposit.status)) {
    return;
  }
  const measured = await client.query<{ total_kg: string }>(
    'SELECT sum(total_kg) AS total_kg FROM scale_samples WHERE deposit_id = $1',
    [depositId],
  );
  const difference =
    toCentiKg(measured.rows[0]?.total_kg ?? 0) - toCentiKg(deposit.estimated_weight_kg);
  if (difference === 0) return;
  const key = {
    warehouseId: deposit.warehouse_id,
    farmerId: deposit.farmer_id,
    commodity: deposit.commodity,
    gradingScheme: deposit.grading_scheme,
    grade: deposit.grade,
  };
  await lockedBalance(client, key);
  // Bags already dispatched at the estimate: post only what the lot still holds.
  const lot = (await lockedLots(client, key)).find((l) => l.depositId === depositId);
  const centiKgDelta = Math.max(difference, -(lot?.centiKg ?? 0));
  if (centiKgDelta === 0) return;
  await postAdjustment(
    client,
    {
      ...key,
      id: randomUUID(),
      bagsDelta: 0,
      centiKgDelta,
      reasonCode: 'scale_reweigh',
      notes: `Every bag weighed: measured ${fromCentiKg(toCentiKg(measured.rows[0]?.total_kg ?? 0))} kg against an estimate of ${deposit.estimated_weight_kg} kg`,
      recordedBy,
      authorisedBy: deposit.verifier_id,
      depositId,
      occurredAt: now,
    },
    keys,
    backend,
  );
}

const SAMPLE_COLUMNS =
  'id, sample_id, deposit_id, bags_weighed, total_kg, recorded_by, recorded_at';

function toView(row: SampleRow): ScaleSampleView {
  const totalCentiKg = toCentiKg(row.total_kg);
  return {
    id: row.id,
    sample_id: row.sample_id,
    deposit_id: row.deposit_id,
    bags_weighed: row.bags_weighed,
    total_kg: fromCentiKg(totalCentiKg),
    kg_per_bag: roundHalfAway(fromCentiKg(totalCentiKg) / row.bags_weighed),
    recorded_by: row.recorded_by,
    recorded_at: row.recorded_at,
  };
}
