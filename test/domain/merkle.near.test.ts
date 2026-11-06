import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NEAR_LEAF_DOMAIN,
  nearLeafBytes,
  nearLeafHash,
  nearRecordBytes,
  weightSourceDiscriminant,
} from '../../src/chain/nearLeaf.js';
import {
  buildTree,
  entryHash,
  foldProof,
  nextHead,
  ZERO_HEAD,
  type BookRecordJson,
  type LeafJson,
} from '../../src/domain/merkle.js';

interface TestVectorFile {
  leaf: LeafJson;
  borsh_hex: string;
  leaf_hash: string;
  vectors: {
    leaf: LeafJson;
    borsh_hex: string;
    leaf_hash: string;
  }[];
  tree: {
    day: number;
    leaves: number;
    root: string;
    proofs: string[][];
    prev_head: string;
    head: string;
  };
}

const vectorPath = resolve(
  import.meta.dirname,
  '../../../farmledge-protocol-near/test-vectors/leaf_hash.json',
);

describe('NEAR Borsh LeafHashPreimage and Merkle tree (test/domain/merkle.near.test.ts)', () => {
  const vectors = JSON.parse(readFileSync(vectorPath, 'utf8')) as TestVectorFile;

  it('reproduces farmledge-protocol-near/test-vectors/leaf_hash.json byte-for-byte', () => {
    expect(Buffer.from(nearLeafBytes(vectors.leaf)).toString('hex')).toBe(vectors.borsh_hex);
    expect(nearLeafHash(vectors.leaf).toString('hex')).toBe(vectors.leaf_hash);
    expect(entryHash(vectors.leaf, 'near').toString('hex')).toBe(vectors.leaf_hash);
    // Auto-detection on NEAR account IDs (non-G... owners) also selects NEAR encoding.
    expect(entryHash(vectors.leaf).toString('hex')).toBe(vectors.leaf_hash);
  });

  it('reproduces all leaf vectors, tree root, proofs, and head chain', () => {
    for (const v of vectors.vectors) {
      expect(Buffer.from(nearLeafBytes(v.leaf)).toString('hex')).toBe(v.borsh_hex);
      expect(nearLeafHash(v.leaf).toString('hex')).toBe(v.leaf_hash);
    }

    const leafHashes = vectors.vectors.map((v) => nearLeafHash(v.leaf));
    const tree = buildTree(leafHashes);
    expect(tree.root.toString('hex')).toBe(vectors.tree.root);

    vectors.vectors.forEach((v, idx) => {
      const proof = (vectors.tree.proofs[idx] ?? []).map((s) => Buffer.from(s, 'hex'));
      const folded = foldProof(nearLeafHash(v.leaf), v.leaf.index, proof);
      expect(folded.toString('hex')).toBe(vectors.tree.root);
    });

    const head = nextHead(
      Buffer.from(vectors.tree.prev_head, 'hex'),
      vectors.tree.day,
      vectors.tree.leaves,
      tree.root,
    );
    expect(head.toString('hex')).toBe(vectors.tree.head);
    expect(nextHead(ZERO_HEAD, vectors.tree.day, vectors.tree.leaves, tree.root)).toEqual(head);
  });

  it('prefixes LeafHashPreimage with the 20-byte FARMLEDGE_LEAF_V3\\0\\0\\0 domain tag and fixes WeightSource discriminants', () => {
    expect(NEAR_LEAF_DOMAIN.length).toBe(20);
    const bytes = Buffer.from(nearLeafBytes(vectors.leaf));
    expect(bytes.subarray(0, 20).equals(NEAR_LEAF_DOMAIN)).toBe(true);
    expect(weightSourceDiscriminant('BagEstimate')).toBe(0);
    expect(weightSourceDiscriminant('Scale')).toBe(1);
  });

  it('changes the leaf hash when any field of LeafJson is mutated', () => {
    const base = vectors.leaf;
    const baseHash = nearLeafHash(base).toString('hex');
    const mutations: Partial<LeafJson>[] = [
      { kind: 0 },
      { warehouse_id: 'KN_OTHER' },
      { day: base.day + 1 },
      { index: base.index + 1 },
      { deposit_no: base.deposit_no + 1 },
      { deposit_id: '00000000-0000-0000-0000-000000000000' },
      { receipt_id: 1 },
      { receipt_version: 1 },
      { owner: 'lender.testnet' },
      { commodity: 'MAIZE_YELLOW' },
      { grade: '2' },
      { kg: base.kg + 1 },
      { weight_source: 'BagEstimate' },
      { bags: base.bags + 1 },
      { moisture_bps: base.moisture_bps + 1 },
      { custodian: 'custodian.testnet' },
      { verifier: 'verifier.testnet' },
      { deposited_at: base.deposited_at + 1 },
      { at: base.at + 1 },
      { salt: 'ff'.repeat(32) },
    ];
    for (const mut of mutations) {
      const changed = nearLeafHash({ ...base, ...mut }).toString('hex');
      expect(changed).not.toBe(baseHash);
    }
  });

  it('encodes BookRecordJson with a distinct domain tag so a record hash can never equal a leaf hash', () => {
    const record: BookRecordJson = {
      record: 'adjustment',
      version: 1,
      warehouse_id: vectors.leaf.warehouse_id,
      day: vectors.leaf.day,
      index: vectors.leaf.index,
      deposit_no: vectors.leaf.deposit_no,
      deposit_id: vectors.leaf.deposit_id,
      source_id: vectors.leaf.deposit_id,
      reason: 'reweigh',
      owner: vectors.leaf.owner,
      bags_delta: -1,
      kg_delta: -5,
      at: vectors.leaf.at,
      salt: vectors.leaf.salt,
    };
    const recBytes = Buffer.from(nearRecordBytes(record));
    expect(recBytes.subarray(0, 20).toString('utf8')).toBe('FARMLEDGE_RECD_V3\0\0\0');
    expect(entryHash(record, 'near').equals(entryHash(vectors.leaf, 'near'))).toBe(false);
  });
});
