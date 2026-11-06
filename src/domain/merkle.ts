import { createHash } from 'node:crypto';

import { Address, xdr } from '@stellar/stellar-sdk';

/**
 * The daily book's Merkle tree, exactly as docs/events.md ("Farmer proofs")
 * and the contract define it:
 *
 *   leaf hash = sha256(0x00 ‖ XDR(leaf as ScVal map, keys sorted))
 *   node      = sha256(0x01 ‖ left ‖ right)
 *   padding   = sha256(0x00), up to a power of two
 *   head      = sha256(prev_head ‖ day ‖ leaves ‖ root), day and leaves u32 big-endian
 *
 * Pure: no I/O. Cross-checked against farmledge-protocol's scripts/verify_proof.py and the
 * contract's own `leaf_hash` in the tests.
 */

export type WeightSourceName = 'Scale' | 'BagEstimate';

/** The contract's `Leaf`, in its JSON form (the bundle's `leaf`). */
export interface LeafJson {
  version: 1;
  /**
   * 0 deposit, 1 dispatch, 2 end-of-day balance, 3 empty-day sentinel (the
   * only leaf of a day with no entries; protocol #7). Only kind 2 can mint.
   */
  kind: 0 | 1 | 2 | 3;
  warehouse_id: string;
  day: number;
  index: number;
  deposit_no: number;
  deposit_id: string;
  receipt_id: number;
  receipt_version: number;
  owner: string;
  commodity: string;
  grade: string;
  kg: number;
  weight_source: WeightSourceName;
  bags: number;
  moisture_bps: number;
  custodian: string;
  verifier: string;
  deposited_at: number;
  at: number;
  /** 32 bytes, hex. */
  salt: string;
}

/**
 * An adjustment or cancellation in the daily book (D32). Not a contract
 * `Leaf` and never mintable: it has different fields, so its hash can't
 * equal any leaf's. It sits in the same tree, so the anchor commits to it.
 */
export interface BookRecordJson {
  record: 'adjustment' | 'cancellation';
  version: 1;
  warehouse_id: string;
  day: number;
  index: number;
  deposit_no: number;
  deposit_id: string;
  /** The adjustment or cancellation id. */
  source_id: string;
  /** The adjustment's reason code, or `cancellation`. */
  reason: string;
  owner: string;
  bags_delta: number;
  /** Change in the lot's whole-kg book balance. */
  kg_delta: number;
  at: number;
  salt: string;
}

export type BookEntryJson = LeafJson | BookRecordJson;

export const isLeaf = (entry: BookEntryJson): entry is LeafJson => !('record' in entry);

type FieldType = 'u32' | 'u64' | 'i64' | 'symbol' | 'string' | 'address' | 'bytes';

const LEAF_FIELDS: Record<Exclude<keyof LeafJson, 'weight_source'>, FieldType> = {
  version: 'u32',
  kind: 'u32',
  warehouse_id: 'symbol',
  day: 'u32',
  index: 'u32',
  deposit_no: 'u64',
  deposit_id: 'string',
  receipt_id: 'u64',
  receipt_version: 'u32',
  owner: 'address',
  commodity: 'symbol',
  grade: 'symbol',
  kg: 'u64',
  bags: 'u32',
  moisture_bps: 'u32',
  custodian: 'address',
  verifier: 'address',
  deposited_at: 'u64',
  at: 'u64',
  salt: 'bytes',
};

const RECORD_FIELDS: Record<keyof BookRecordJson, FieldType> = {
  record: 'symbol',
  version: 'u32',
  warehouse_id: 'symbol',
  day: 'u32',
  index: 'u32',
  deposit_no: 'u64',
  deposit_id: 'string',
  source_id: 'string',
  reason: 'symbol',
  owner: 'address',
  bags_delta: 'i64',
  kg_delta: 'i64',
  at: 'u64',
  salt: 'bytes',
};

function scVal(type: FieldType, value: unknown): xdr.ScVal {
  switch (type) {
    case 'u32':
      return xdr.ScVal.scvU32(Number(value));
    case 'u64':
      return xdr.ScVal.scvU64(BigInt(value as number));
    case 'i64':
      return xdr.ScVal.scvI64(BigInt(value as number));
    case 'symbol':
      return xdr.ScVal.scvSymbol(String(value));
    case 'string':
      return xdr.ScVal.scvString(String(value));
    case 'address':
      return Address.fromString(String(value)).toScVal();
    case 'bytes':
      return xdr.ScVal.scvBytes(Buffer.from(String(value), 'hex'));
  }
}

/** A map keyed by symbols in sorted order, as the host requires. */
function sortedMap(entries: [string, xdr.ScVal][]): xdr.ScVal {
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(
    entries.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  );
}

/** The leaf as the contract's `Leaf` ScVal (what `leaf_hash` and `mint_from_anchor` take). */
export function leafScVal(leaf: LeafJson): xdr.ScVal {
  const entries = (Object.keys(LEAF_FIELDS) as (keyof typeof LEAF_FIELDS)[]).map(
    (key): [string, xdr.ScVal] => [key, scVal(LEAF_FIELDS[key], leaf[key])],
  );
  entries.push(['weight_source', xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(leaf.weight_source)])]);
  return sortedMap(entries);
}

function recordScVal(record: BookRecordJson): xdr.ScVal {
  return sortedMap(
    (Object.keys(RECORD_FIELDS) as (keyof BookRecordJson)[]).map((key): [string, xdr.ScVal] => [
      key,
      scVal(RECORD_FIELDS[key], record[key]),
    ]),
  );
}

export function sha256(...parts: Uint8Array[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);
/** Fills a tree out to a power of two. */
export const PADDING = sha256(LEAF_PREFIX);

export function entryHash(entry: BookEntryJson): Buffer {
  const val = isLeaf(entry) ? leafScVal(entry) : recordScVal(entry);
  return sha256(LEAF_PREFIX, val.toXdr());
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/** Proof length for a tree of `leaves` leaves: ceil(log2(leaves)). */
export function depthFor(leaves: number): number {
  return leaves <= 1 ? 0 : (leaves - 1).toString(2).length;
}

export interface Tree {
  root: Buffer;
  /** proofs[i]: sibling hashes from leaf i up to the root. */
  proofs: Buffer[][];
}

export function buildTree(leafHashes: readonly Buffer[]): Tree {
  if (leafHashes.length === 0) throw new Error('a tree needs at least one leaf');
  const width = 2 ** depthFor(leafHashes.length);
  let level: Buffer[] = [...leafHashes];
  while (level.length < width) level.push(PADDING);
  const proofs: Buffer[][] = leafHashes.map(() => []);
  const positions = leafHashes.map((_, i) => i);
  while (level.length > 1) {
    for (let i = 0; i < leafHashes.length; i++) {
      const pos = positions[i] ?? 0;
      const sibling = level[pos ^ 1];
      if (sibling === undefined) throw new Error('tree level has no sibling');
      proofs[i]?.push(sibling);
      positions[i] = pos >> 1;
    }
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(nodeHash(level[i] as Buffer, level[i + 1] as Buffer));
    }
    level = next;
  }
  return { root: level[0] as Buffer, proofs };
}

/** Folds a leaf hash and its proof into a root, as verify_proof.py does. */
export function foldProof(hash: Buffer, index: number, proof: readonly Buffer[]): Buffer {
  let h = hash;
  let i = index;
  for (const sibling of proof) {
    h = i % 2 === 0 ? nodeHash(h, sibling) : nodeHash(sibling, h);
    i = Math.floor(i / 2);
  }
  return h;
}

const u32be = (n: number) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n);
  return buf;
};

export const ZERO_HEAD = Buffer.alloc(32);

export function nextHead(prevHead: Uint8Array, day: number, leaves: number, root: Uint8Array) {
  return sha256(prevHead, u32be(day), u32be(leaves), root);
}

/**
 * Canonical order of a day's entries (protocol #8): by rank (deposit 0,
 * dispatch 1, balance 2, adjustment 3, cancellation 4), then deposit_no,
 * then `at`, then source id as a byte string: the dispatch, adjustment or
 * cancellation id, or the deposit_id for deposit and balance leaves. A
 * sentinel (kind 3) is alone in its tree, so its rank never matters.
 */
export interface Orderable {
  readonly entry:
    | { readonly kind: number; readonly deposit_no: number; readonly at: number }
    | { readonly record: string; readonly deposit_no: number; readonly at: number };
  readonly sourceId: string;
}

export function compareEntries(a: Orderable, b: Orderable): number {
  const rank = (o: Orderable) =>
    'record' in o.entry ? 3 + (o.entry.record === 'adjustment' ? 0 : 1) : o.entry.kind;
  return (
    rank(a) - rank(b) ||
    a.entry.deposit_no - b.entry.deposit_no ||
    a.entry.at - b.entry.at ||
    Buffer.compare(Buffer.from(a.sourceId), Buffer.from(b.sourceId))
  );
}
