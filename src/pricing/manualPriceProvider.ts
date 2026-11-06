import type { Queryable } from '../db/pool.js';
import type { Price, PricingProvider, PriceQuery } from './pricingProvider.js';

/**
 * PRICING_PROVIDER=manual. Prices are entered by hand (POST /prices). A
 * price for the exact grade wins over a commodity-wide one (null grade).
 */
export class ManualPriceProvider implements PricingProvider {
  constructor(private readonly db: Queryable) {}

  async priceFor(query: PriceQuery): Promise<Price | null> {
    const { rows } = await this.db.query<{
      price_per_tonne_ngn: string;
      effective_from: string;
      grade: string | null;
    }>(
      `SELECT price_per_tonne_ngn, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, grade
       FROM manual_prices
       WHERE commodity = $1 AND grading_scheme = $2 AND (grade = $3 OR grade IS NULL)
         AND effective_from <= $4::date
       ORDER BY grade IS NULL, effective_from DESC
       LIMIT 1`,
      [query.commodity, query.gradingScheme, query.grade, query.asOf],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      pricePerTonneNgn: Number(row.price_per_tonne_ngn),
      effectiveFrom: row.effective_from,
      source: 'manual',
      gradeSpecific: row.grade !== null,
    };
  }
}
