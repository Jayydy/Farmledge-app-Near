export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 10 * 60_000;

/**
 * Delay before retry number `attempts` (1 = first retry): exponential from
 * 5 s, capped at 10 min, with "equal jitter" (half fixed, half random) so a
 * room full of tablets coming back online doesn't retry in step. Never gives
 * up: an item is only taken out of the retry cycle when the API rejects it.
 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(exponential / 2 + (exponential / 2) * random());
}
