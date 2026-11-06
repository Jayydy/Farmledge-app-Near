import { Address, xdr } from '@stellar/stellar-sdk';

import {
  isLeaf,
  type BookEntryJson,
  type BookRecordJson,
  type LeafJson,
} from '../domain/merkle.js';

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

/** A map keyed by symbols in sorted order, as the Soroban host requires. */
function sortedMap(entries: [string, xdr.ScVal][]): xdr.ScVal {
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(
    entries.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  );
}

/** The leaf as the Stellar contract's `Leaf` ScVal (what `leaf_hash` and `mint_from_anchor` take). */
export function leafScVal(leaf: LeafJson): xdr.ScVal {
  const entries = (Object.keys(LEAF_FIELDS) as (keyof typeof LEAF_FIELDS)[]).map(
    (key): [string, xdr.ScVal] => [key, scVal(LEAF_FIELDS[key], leaf[key])],
  );
  entries.push(['weight_source', xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(leaf.weight_source)])]);
  return sortedMap(entries);
}

export function recordScVal(record: BookRecordJson): xdr.ScVal {
  return sortedMap(
    (Object.keys(RECORD_FIELDS) as (keyof BookRecordJson)[]).map((key): [string, xdr.ScVal] => [
      key,
      scVal(RECORD_FIELDS[key], record[key]),
    ]),
  );
}

export function stellarEntryBytes(entry: BookEntryJson): Uint8Array {
  const val = isLeaf(entry) ? leafScVal(entry) : recordScVal(entry);
  return val.toXdr();
}
