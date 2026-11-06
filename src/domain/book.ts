/**
 * The daily book: days, cutoffs, on-chain identifiers, and the checks a day
 * must pass before it is anchored (INV-3, INV-4). Pure.
 */

const DAY_SECONDS = 86_400;

/** UTC day number: Unix seconds ÷ 86,400, rounded down (docs/events.md). */
export function utcDay(at: Date): number {
  return Math.floor(at.getTime() / 1000 / DAY_SECONDS);
}

/** A day's cutoff: 00:00 UTC of the next day. Its book holds what was recorded before it. */
export function cutoffOf(day: number): Date {
  return new Date((day + 1) * DAY_SECONDS * 1000);
}

/** A balance leaf's `at`: the last second of its day. */
export function endOfDaySeconds(day: number): number {
  return (day + 1) * DAY_SECONDS - 1;
}

export const unixSeconds = (at: Date) => Math.floor(at.getTime() / 1000);

const SYMBOL = /^[A-Za-z0-9_]{1,32}$/;

/**
 * The warehouse's on-chain id. Warehouse codes allow `-`, which a Soroban
 * Symbol does not; codes never contain `_`, so `-` → `_` is one-to-one.
 */
export function warehouseSymbol(code: string): string {
  const symbol = code.replaceAll('-', '_');
  if (!SYMBOL.test(symbol)) throw new Error(`warehouse code ${code} has no valid chain symbol`);
  return symbol;
}

/** Grades and commodities go on-chain as Symbols; refuse anything that isn't one. */
export function chainSymbol(value: string, what: string): string {
  if (!SYMBOL.test(value)) {
    throw new Error(`${what} "${value}" is not a valid Soroban Symbol ([A-Za-z0-9_], ≤ 32)`);
  }
  return value;
}

// --- Checks before a day is anchored -----------------------------------------

export interface LotTotals {
  bags: number;
  kg: number;
}

export interface DayMovement {
  readonly depositNo: number;
  /** Deposit leaf: the lot's intake. */
  readonly isDeposit: boolean;
  readonly bagsDelta: number;
  readonly kgDelta: number;
}

export interface DayCheckInput {
  /** Balance leaves of the previous closed day, by deposit_no. */
  readonly previous: ReadonlyMap<number, LotTotals>;
  /** Today's deposit, dispatch and record entries, as signed deltas. */
  readonly movements: readonly DayMovement[];
  /** Today's balance leaves, by deposit_no. */
  readonly balances: ReadonlyMap<number, LotTotals>;
  /** Highest deposit_no in any earlier deposit leaf of the warehouse (0 if none). */
  readonly lastDepositNo: number;
  /** Empty-day sentinel leaves (kind 3) in today's tree. */
  readonly sentinels: number;
  /** Every entry in today's tree, sentinels included. */
  readonly entries: number;
}

/**
 * Problems that must stop an anchor and page someone:
 * - INV-3: today's deposit leaves are exactly the next contiguous numbers,
 *   one each;
 * - INV-4: for every lot, yesterday's balance plus today's entries equals
 *   today's balance leaf. A lot that holds stock but has no balance leaf
 *   fails this too: its missing leaf counts as zero;
 * - protocol #7: a day with no other entry has exactly one sentinel leaf,
 *   and a sentinel appears on no other day.
 */
export function checkDay(input: DayCheckInput): string[] {
  const problems: string[] = [];

  if (input.entries === 0) {
    problems.push('INV-5: the day has no entries; an empty day needs one sentinel leaf');
  } else if (input.sentinels > 0 && (input.sentinels !== 1 || input.entries !== 1)) {
    problems.push(
      `INV-4: a sentinel leaf must be the only entry of its day; found ${input.sentinels} sentinel(s) among ${input.entries} entries`,
    );
  }

  const numbers = input.movements
    .filter((m) => m.isDeposit)
    .map((m) => m.depositNo)
    .sort((a, b) => a - b);
  numbers.forEach((no, i) => {
    const expected = input.lastDepositNo + 1 + i;
    if (no !== expected) {
      problems.push(
        `INV-3: deposit leaves must number ${input.lastDepositNo + 1}..${input.lastDepositNo + numbers.length} contiguously; found ${no} where ${expected} belongs`,
      );
    }
  });

  const lots = new Set<number>([
    ...input.previous.keys(),
    ...input.balances.keys(),
    ...input.movements.map((m) => m.depositNo),
  ]);
  for (const lot of [...lots].sort((a, b) => a - b)) {
    const before = input.previous.get(lot) ?? { bags: 0, kg: 0 };
    const expected = input.movements
      .filter((m) => m.depositNo === lot)
      .reduce((sum, m) => ({ bags: sum.bags + m.bagsDelta, kg: sum.kg + m.kgDelta }), before);
    const actual = input.balances.get(lot) ?? { bags: 0, kg: 0 };
    if (expected.bags !== actual.bags || expected.kg !== actual.kg) {
      problems.push(
        `INV-4: lot ${lot} should hold ${expected.bags} bags / ${expected.kg} kg from yesterday's balance and today's entries, but its balance leaf says ${actual.bags} bags / ${actual.kg} kg`,
      );
    }
    if (actual.bags < 0 || actual.kg < 0) {
      problems.push(`INV-4: lot ${lot} has a negative balance`);
    }
  }
  return problems;
}
