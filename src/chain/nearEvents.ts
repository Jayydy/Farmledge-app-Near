import {
  EVENT_TOPICS,
  type ChainEvent,
  type DecodedEvent,
  type EventJson,
  type EventPage,
} from './chainClient.js';
import type { NearRpc } from './nearRpc.js';

export const NEP297_PREFIX = 'EVENT_JSON:';
export const FARMLEDGE_STANDARD = 'farmledge_receipt';
export const FARMLEDGE_EVENT_VERSION = '3.0.0';

/** All 21 data_version 3 events plus the 2 NEAR-specific intent events. */
export const KNOWN_NEAR_EVENTS = new Set<string>([
  ...Object.keys(EVENT_TOPICS),
  'mint_proposed',
  'lock_offered',
]);

export interface Nep297Envelope {
  readonly standard?: unknown;
  readonly version?: unknown;
  readonly event?: unknown;
  readonly data?: unknown;
}

export interface Nep297EventMeta {
  readonly blockHeight: number;
  readonly blockTimestampNs: string | number | bigint;
  readonly txHash: string;
  readonly contractId?: string;
  readonly txIndex?: number;
  readonly inSuccessfulContractCall?: boolean;
}

function toEventJson(value: unknown): EventJson {
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(toEventJson);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toEventJson(v)]));
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return null;
}

/**
 * Parses NEP-297 `EVENT_JSON:` log lines emitted by the NEAR receipt contract
 * into `ChainEvent[]` with pre-decoded `DecodedEvent` payloads.
 */
export function parseNep297Events(
  logs: readonly string[],
  meta: Nep297EventMeta,
): ChainEvent[] {
  const out: ChainEvent[] = [];
  const closedMs = Number(BigInt(meta.blockTimestampNs) / 1_000_000n);
  const ledgerClosedAt = new Date(closedMs).toISOString();
  const contractId = meta.contractId ?? '';
  const txIndex = meta.txIndex ?? 0;
  const inSuccessfulContractCall = meta.inSuccessfulContractCall ?? true;

  logs.forEach((line, logIdx) => {
    if (!line.startsWith(NEP297_PREFIX)) return;
    const rawJson = line.slice(NEP297_PREFIX.length).trim();
    let parsed: Nep297Envelope | null;
    try {
      parsed = JSON.parse(rawJson) as Nep297Envelope | null;
    } catch {
      return;
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      parsed.standard !== FARMLEDGE_STANDARD ||
      parsed.version !== FARMLEDGE_EVENT_VERSION ||
      typeof parsed.event !== 'string' ||
      parsed.event.length === 0
    ) {
      return;
    }

    const name = parsed.event;
    const items = Array.isArray(parsed.data)
      ? parsed.data
      : parsed.data !== undefined && parsed.data !== null && typeof parsed.data === 'object'
        ? [parsed.data]
        : [{}];

    items.forEach((rawItem, dataIdx) => {
      const normalized = toEventJson(rawItem);
      const fields: Record<string, EventJson> =
        normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized)
          ? { ...normalized }
          : {};
      const topicFields = EVENT_TOPICS[name] ?? [];
      const topics: EventJson[] = [name, ...topicFields.map((f) => fields[f] ?? null)];
      const decoded: DecodedEvent = { name, fields, topics };
      const id = `${meta.blockHeight}-${meta.txHash}-${logIdx}-${dataIdx}`;

      out.push({
        id,
        contractId,
        ledger: meta.blockHeight,
        ledgerClosedAt,
        txHash: meta.txHash,
        txIndex,
        opIndex: logIdx,
        eventIndex: logIdx * 1_000 + dataIdx,
        inSuccessfulContractCall,
        topicXdr: [name],
        valueXdr: line,
        decoded,
        raw: line,
      });
    });
  });

  return out;
}

export interface NearIndexerTxRef {
  readonly txHash: string;
  readonly signerId: string;
  readonly blockHeight: number;
  readonly blockTimestampNs?: string;
}

export interface FetchNearEventsOptions {
  readonly contractId: string;
  readonly indexerUrl?: string;
  readonly startLedger: number;
  readonly endLedger?: number;
  readonly fetchFn?: typeof fetch;
}

/**
 * Fetches NEAR contract events over `[startLedger, endLedger)` via the
 * configured indexer HTTP endpoint + `txStatus` outcome log extraction.
 */
export async function fetchNearEvents(
  rpc: NearRpc,
  options: FetchNearEventsOptions,
): Promise<EventPage> {
  const status = await rpc.status();
  const latestLedger = status.sync_info.latest_block_height;
  const oldestLedger = status.sync_info.earliest_block_height ?? 1;
  const bound =
    options.endLedger === undefined
      ? latestLedger
      : Math.min(options.endLedger - 1, latestLedger);

  if (bound < options.startLedger) {
    return {
      events: [],
      latestLedger,
      oldestLedger,
      coveredThrough: bound,
      cursor: String(bound),
    };
  }

  const txRefs = await queryIndexerTxRefs(options);
  const events: ChainEvent[] = [];

  for (let txIdx = 0; txIdx < txRefs.length; txIdx++) {
    const ref = txRefs[txIdx];
    if (ref === undefined) continue;
    if (ref.blockHeight < options.startLedger || ref.blockHeight > bound) continue;

    const tx = await rpc.txStatus(ref.txHash, ref.signerId);
    if (tx === null) continue;
    const txSucceeded = tx.status.Failure === undefined;

    let blockTimestampNs = ref.blockTimestampNs;
    if (blockTimestampNs === undefined) {
      try {
        const blk = await rpc.block({ blockId: ref.blockHeight });
        blockTimestampNs = blk.header.timestamp_nanosec ?? String(blk.header.timestamp);
      } catch {
        blockTimestampNs = String(BigInt(Date.parse(status.sync_info.latest_block_time)) * 1_000_000n);
      }
    }

    const allOutcomes = [tx.transaction_outcome, ...tx.receipts_outcome];
    const logs: string[] = [];
    for (const outcome of allOutcomes) {
      if (
        outcome.outcome.executor_id === options.contractId &&
        outcome.outcome.status.Failure === undefined
      ) {
        logs.push(...outcome.outcome.logs);
      }
    }

    events.push(
      ...parseNep297Events(logs, {
        blockHeight: ref.blockHeight,
        blockTimestampNs,
        txHash: ref.txHash,
        contractId: options.contractId,
        txIndex: txIdx,
        inSuccessfulContractCall: txSucceeded,
      }),
    );
  }

  return {
    events,
    latestLedger,
    oldestLedger,
    coveredThrough: bound,
    cursor: String(bound),
  };
}

async function queryIndexerTxRefs(
  options: FetchNearEventsOptions,
): Promise<NearIndexerTxRef[]> {
  if (!options.indexerUrl) return [];
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const url = `${options.indexerUrl.replace(/\/+$/, '')}/account/${encodeURIComponent(options.contractId)}/activity`;
  try {
    const res = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const items = (await res.json()) as {
      hash?: string;
      tx_hash?: string;
      signer_id?: string;
      block_height?: number;
      block_timestamp?: string | number;
    }[];
    if (!Array.isArray(items)) return [];
    const seen = new Set<string>();
    const out: NearIndexerTxRef[] = [];
    for (const item of items) {
      const txHash = item.hash ?? item.tx_hash;
      const signerId = item.signer_id;
      const blockHeight = item.block_height ?? 0;
      if (!txHash || !signerId || !Number.isFinite(blockHeight) || seen.has(txHash)) continue;
      seen.add(txHash);
      out.push({
        txHash,
        signerId,
        blockHeight,
        ...(item.block_timestamp !== undefined
          ? { blockTimestampNs: String(item.block_timestamp) }
          : {}),
      });
    }
    return out.sort((a, b) => a.blockHeight - b.blockHeight);
  } catch {
    return [];
  }
}
