import type { Commodity, CommodityConfig } from '../config/index.js';

export interface DerivedWeight {
  /** Bag size in force, recorded on the deposit so the estimate stays auditable. */
  readonly bagSizeKg: number;
  readonly weightKg: number;
}

/**
 * Bag-estimate weight: bag count × the commodity's configured bag size. The
 * database computes the same figure as `deposits.estimated_weight_kg` from
 * the stored bag size, so the two cannot disagree.
 */
export function deriveWeight(
  bagCount: number,
  commodity: Commodity,
  commodities: Readonly<Record<Commodity, CommodityConfig>>,
): DerivedWeight {
  if (!Number.isSafeInteger(bagCount) || bagCount <= 0) {
    throw new RangeError(`bagCount must be a positive integer, got ${bagCount}`);
  }
  const bagSizeKg = commodities[commodity].bagSizeKg;
  return { bagSizeKg, weightKg: bagCount * bagSizeKg };
}
