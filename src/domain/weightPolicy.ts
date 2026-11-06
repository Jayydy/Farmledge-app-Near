import type { WeightMode } from '../config/index.js';
import { domainError, fail, ok, type Result } from './errors.js';

/**
 * Where intake weight comes from and what may be pledged (docs/decisions.md,
 * provision f). This is the only place either rule lives.
 */

export type WeightSource = 'bag_estimate' | 'scale';

/** WEIGHT_MODE=bag_estimate: bags × bag size. scale_required: every bag weighed. */
export function intakeWeightSource(mode: WeightMode): WeightSource {
  return mode === 'scale_required' ? 'scale' : 'bag_estimate';
}

export interface PledgeCandidate {
  readonly weightSource: string;
  readonly bagCount: number;
  readonly bagsWeighed: number;
}

/**
 * A receipt may back a loan only when its weight was measured: a scale
 * deposit with every bag weighed. Nothing pledges yet (LENDING_ENABLED),
 * so nothing calls this outside tests; the lock flow must call it first.
 */
export function assertPledgeable(deposit: PledgeCandidate): Result<true> {
  if (deposit.weightSource !== 'scale') {
    return fail([
      domainError(
        'invalid_kg',
        'weight_source',
        'Only scale-weighed stock can be pledged; this deposit is a bag estimate',
      ),
    ]);
  }
  if (deposit.bagsWeighed < deposit.bagCount) {
    return fail([
      domainError(
        'invalid_kg',
        'weight_source',
        `Only ${deposit.bagsWeighed} of ${deposit.bagCount} bags have been weighed`,
      ),
    ]);
  }
  return ok(true);
}
