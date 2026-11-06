/**
 * Lots (docs/decisions.md D29). Every deposit is a lot, identified on-chain
 * by (warehouse, deposit_no). Stock is still kept per farmer and grade, and
 * each movement is split across lots by these rules:
 *
 * - a dispatch draws whole bags from the farmer's **oldest** free lots of
 *   that grade first, unless the tablet names one lot (`deposit_id`); the kg
 *   leaving a lot is its bags' share of the lot (all its bags take all its kg);
 * - a decrease by adjustment draws the same way, with its own kg;
 * - an increase by adjustment goes to the **newest** free lot;
 * - **frozen** (mint pending) and **minted** lots are never drawn or
 *   adjusted off-chain (INV-1, INV-6, D33). They are not free balance.
 *
 * Quantities are integer hundredths of a kg, as elsewhere.
 */

export interface LotBalance {
  readonly depositId: string;
  readonly depositNo: number;
  readonly intakeAt: Date;
  readonly bags: number;
  readonly centiKg: number;
  /** Mint pending (INV-1) or minted (INV-6): not drawable off-chain. */
  readonly governedOnChain: boolean;
}

export interface LotDraw {
  readonly depositId: string;
  readonly depositNo: number;
  /** Negative for a draw. */
  readonly bagsDelta: number;
  readonly centiKgDelta: number;
}

export type DrawResult =
  | { readonly ok: true; readonly draws: LotDraw[] }
  | {
      readonly ok: false;
      readonly reason: 'insufficient' | 'lot_governed_on_chain' | 'lot_not_found';
      readonly freeBags: number;
      readonly freeCentiKg: number;
    };

const oldestFirst = (a: LotBalance, b: LotBalance) =>
  a.intakeAt.getTime() - b.intakeAt.getTime() || a.depositNo - b.depositNo;

export function freeBalance(lots: readonly LotBalance[]): { bags: number; centiKg: number } {
  return lots
    .filter((lot) => !lot.governedOnChain)
    .reduce((sum, lot) => ({ bags: sum.bags + lot.bags, centiKg: sum.centiKg + lot.centiKg }), {
      bags: 0,
      centiKg: 0,
    });
}

/**
 * Takes `bags` bags (and, for an adjustment, exactly `centiKg`) out of the
 * lots. With `centiKg` null the kg follows the bags (a dispatch).
 */
export function planDraw(
  lots: readonly LotBalance[],
  request: { bags: number; centiKg: number | null; depositId?: string | null | undefined },
): DrawResult {
  const free = freeBalance(lots);
  const refuse = (reason: 'insufficient' | 'lot_governed_on_chain' | 'lot_not_found') => ({
    ok: false as const,
    reason,
    freeBags: free.bags,
    freeCentiKg: free.centiKg,
  });
  let candidates = lots.filter((lot) => lot.bags > 0 || lot.centiKg > 0);
  if (request.depositId !== undefined && request.depositId !== null) {
    const named = lots.find((lot) => lot.depositId === request.depositId);
    if (named === undefined) return refuse('lot_not_found');
    if (named.governedOnChain) return refuse('lot_governed_on_chain');
    candidates = [named];
  } else {
    candidates = candidates.filter((lot) => !lot.governedOnChain);
  }
  candidates = [...candidates].sort(oldestFirst);

  let bags = request.bags;
  let centiKg = request.centiKg;
  const draws: LotDraw[] = [];
  for (const lot of candidates) {
    if (bags <= 0 && (centiKg === null || centiKg <= 0)) break;
    const takeBags = Math.min(lot.bags, bags);
    let takeKg: number;
    if (centiKg === null) {
      takeKg = takeBags >= lot.bags ? lot.centiKg : Math.round((lot.centiKg * takeBags) / lot.bags);
    } else if (centiKg <= 0) {
      takeKg = 0;
    } else if (takeBags >= bags || takeBags >= lot.bags) {
      // This lot covers the rest of the bags (or gives all it has): it takes
      // as much of the kg as it holds; any kg left over moves to the next lot.
      takeKg = Math.min(lot.centiKg, centiKg);
    } else {
      takeKg = Math.min(Math.round((lot.centiKg * takeBags) / lot.bags), centiKg);
    }
    if (takeBags === 0 && takeKg === 0) continue;
    draws.push({
      depositId: lot.depositId,
      depositNo: lot.depositNo,
      bagsDelta: -takeBags,
      centiKgDelta: -takeKg,
    });
    bags -= takeBags;
    if (centiKg !== null) centiKg -= takeKg;
  }
  if (bags > 0 || (centiKg !== null && centiKg > 0)) return refuse('insufficient');
  return { ok: true, draws };
}

/** An increase goes to the named lot, or else the newest free lot. */
export function planIncrease(
  lots: readonly LotBalance[],
  request: { bags: number; centiKg: number; depositId?: string | null | undefined },
): DrawResult {
  const free = freeBalance(lots);
  const refuse = (reason: 'insufficient' | 'lot_governed_on_chain' | 'lot_not_found') => ({
    ok: false as const,
    reason,
    freeBags: free.bags,
    freeCentiKg: free.centiKg,
  });
  let target: LotBalance | undefined;
  if (request.depositId !== undefined && request.depositId !== null) {
    target = lots.find((lot) => lot.depositId === request.depositId);
    if (target === undefined) return refuse('lot_not_found');
    if (target.governedOnChain) return refuse('lot_governed_on_chain');
  } else {
    target = [...lots]
      .filter((lot) => !lot.governedOnChain)
      .sort(oldestFirst)
      .at(-1);
    if (target === undefined) return refuse('lot_not_found');
  }
  return {
    ok: true,
    draws: [
      {
        depositId: target.depositId,
        depositNo: target.depositNo,
        bagsDelta: request.bags,
        centiKgDelta: request.centiKg,
      },
    ],
  };
}

/** Change in a lot's whole-kg book balance: floor(after) − floor(before). */
export function bookKgDelta(beforeCentiKg: number, deltaCentiKg: number): number {
  return Math.floor((beforeCentiKg + deltaCentiKg) / 100) - Math.floor(beforeCentiKg / 100);
}
