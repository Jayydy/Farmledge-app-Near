import type { AnchoringService } from './anchoring.js';
import type { IndexerService } from './indexer.js';
import type { ReconciliationService } from './reconciliation.js';

export interface IndexJobReport {
  archived: number | null;
  mintFindings: number | null;
  /** Whether the hourly anchor retry ran this time. */
  anchorRetried: boolean;
  /** Why indexing failed, if it did; the anchor checks ran regardless. */
  indexError: string | null;
}

/**
 * The 5-minute `index` job (npm run chain -- index): archive new events and
 * reconcile mints, then, **whatever happened above**, retry anchoring if a
 * day is due (at most hourly) and check for missed anchors. A missed anchor
 * is urgent from 2 hours after the cutoff, so it is checked here rather than
 * only in the daily anchor run, and a failure in indexing never hides it.
 */
export async function indexJob(services: {
  indexer: Pick<IndexerService, 'ingest'>;
  reconciliation: Pick<ReconciliationService, 'checkMints'>;
  anchoring: Pick<AnchoringService, 'retryIfDue' | 'checkMissedAnchors'>;
}): Promise<IndexJobReport> {
  const report: IndexJobReport = {
    archived: null,
    mintFindings: null,
    anchorRetried: false,
    indexError: null,
  };
  let failure: Error | null = null;
  try {
    report.archived = (await services.indexer.ingest()).archived;
    report.mintFindings = (await services.reconciliation.checkMints()).length;
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
    report.indexError = failure.message;
  }
  report.anchorRetried = await services.anchoring.retryIfDue();
  await services.anchoring.checkMissedAnchors();
  // The job still fails, so the scheduler sees it, but only after the anchor checks ran.
  if (failure !== null) throw failure;
  return report;
}
