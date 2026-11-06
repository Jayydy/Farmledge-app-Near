/**
 * Commodity prices (provision i). Used only to value stock in reports;
 * nothing is priced for lending.
 */
export interface PricingProvider {
  /** The price in force on `asOf` (a business date), or null if none is known. */
  priceFor(query: PriceQuery): Promise<Price | null>;
}

export interface PriceQuery {
  readonly commodity: string;
  readonly gradingScheme: string;
  readonly grade: string;
  readonly asOf: string;
}

export interface Price {
  readonly pricePerTonneNgn: number;
  readonly effectiveFrom: string;
  /** e.g. `manual`. */
  readonly source: string;
  /** False when this is the commodity-wide price, not one for the grade. */
  readonly gradeSpecific: boolean;
}
