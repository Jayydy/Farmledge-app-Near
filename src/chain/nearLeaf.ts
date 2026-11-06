import { createHash } from 'node:crypto';

import { serialize, type Schema } from 'borsh';

import {
  isLeaf,
  type BookEntryJson,
  type BookRecordJson,
  type LeafJson,
} from '../domain/merkle.js';

export const NEAR_LEAF_DOMAIN = Buffer.from('FARMLEDGE_LEAF_V3\0\0\0', 'utf8'); // 20 bytes
export const NEAR_RECORD_DOMAIN = Buffer.from('FARMLEDGE_RECD_V3\0\0\0', 'utf8'); // 20 bytes

export const LEAF_PREIMAGE_SCHEMA: Schema = {
  struct: {
    domain: { array: { type: 'u8', len: 20 } },
    version: 'u32',
    kind: 'u8',
    warehouse_id: 'string',
    day: 'u32',
    index: 'u32',
    deposit_no: 'u64',
    deposit_id: 'string',
    receipt_id: 'u64',
    receipt_version: 'u32',
    owner: 'string',
    commodity: 'string',
    grade: 'string',
    kg: 'i128',
    weight_source: 'u8',
    bags: 'u32',
    moisture_bps: 'u32',
    custodian: 'string',
    verifier: 'string',
    deposited_at: 'u64',
    at: 'u64',
    salt: { array: { type: 'u8', len: 32 } },
  },
};

const RECORD_PREIMAGE_SCHEMA: Schema = {
  struct: {
    domain: { array: { type: 'u8', len: 20 } },
    record: 'string',
    version: 'u32',
    warehouse_id: 'string',
    day: 'u32',
    index: 'u32',
    deposit_no: 'u64',
    deposit_id: 'string',
    source_id: 'string',
    reason: 'string',
    owner: 'string',
    bags_delta: 'i64',
    kg_delta: 'i64',
    at: 'u64',
    salt: { array: { type: 'u8', len: 32 } },
  },
};

function saltBytes(hex: string): number[] {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error(`salt must be 32 bytes (64 hex chars), got ${buf.length} bytes`);
  }
  return Array.from(buf);
}

/** WeightSource Borsh discriminant: BagEstimate = 0, Scale = 1. */
export function weightSourceDiscriminant(ws: LeafJson['weight_source']): number {
  return ws === 'Scale' ? 1 : 0;
}

/** Borsh-encoded `LeafHashPreimage` matching `farmledge-protocol-near/contracts/receipt/src/merkle.rs`. */
export function nearLeafBytes(leaf: LeafJson): Uint8Array {
  return serialize(LEAF_PREIMAGE_SCHEMA, {
    domain: Array.from(NEAR_LEAF_DOMAIN),
    version: leaf.version,
    kind: leaf.kind,
    warehouse_id: leaf.warehouse_id,
    day: leaf.day,
    index: leaf.index,
    deposit_no: BigInt(leaf.deposit_no),
    deposit_id: leaf.deposit_id,
    receipt_id: BigInt(leaf.receipt_id),
    receipt_version: leaf.receipt_version,
    owner: leaf.owner,
    commodity: leaf.commodity,
    grade: leaf.grade,
    kg: BigInt(leaf.kg),
    weight_source: weightSourceDiscriminant(leaf.weight_source),
    bags: leaf.bags,
    moisture_bps: leaf.moisture_bps,
    custodian: leaf.custodian,
    verifier: leaf.verifier,
    deposited_at: BigInt(leaf.deposited_at),
    at: BigInt(leaf.at),
    salt: saltBytes(leaf.salt),
  });
}

export function nearRecordBytes(record: BookRecordJson): Uint8Array {
  return serialize(RECORD_PREIMAGE_SCHEMA, {
    domain: Array.from(NEAR_RECORD_DOMAIN),
    record: record.record,
    version: record.version,
    warehouse_id: record.warehouse_id,
    day: record.day,
    index: record.index,
    deposit_no: BigInt(record.deposit_no),
    deposit_id: record.deposit_id,
    source_id: record.source_id,
    reason: record.reason,
    owner: record.owner,
    bags_delta: BigInt(record.bags_delta),
    kg_delta: BigInt(record.kg_delta),
    at: BigInt(record.at),
    salt: saltBytes(record.salt),
  });
}

export function nearEntryBytes(entry: BookEntryJson): Uint8Array {
  return isLeaf(entry) ? nearLeafBytes(entry) : nearRecordBytes(entry);
}

/** `sha256(0x00 || borsh(LeafHashPreimage))` matching the NEAR contract's `leaf_hash(leaf)`. */
export function nearLeafHash(leaf: LeafJson): Buffer {
  return createHash('sha256')
    .update(Buffer.from([0x00]))
    .update(nearLeafBytes(leaf))
    .digest();
}
