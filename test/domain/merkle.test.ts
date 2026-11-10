import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import {
  buildTree,
  compareEntries,
  depthFor,
  entryHash,
  foldProof,
  nextHead,
  PADDING,
  sha256,
  ZERO_HEAD,
  type BookRecordJson,
  type LeafJson,
} from '../../src/domain/merkle.js';
import { findVerifyProofScript, verifyProofScript } from '../helpers/verifyProof.js';

const SCRIPT = findVerifyProofScript();

function leaf(overrides: Partial<LeafJson> = {}): LeafJson {
  return {
    version: 1,
    kind: 2,
    warehouse_id: 'KN_DAWANAU',
    day: 20_366,
    index: 0,
    deposit_no: 7,
    deposit_id: 'b3f1c2d4-0000-4000-8000-000000000007',
    receipt_id: 0,
    receipt_version: 0,
    owner: Keypair.random().publicKey(),
    commodity: 'MAIZE_WHITE',
    grade: '1',
    kg: 2_000,
    weight_source: 'Scale',
    bags: 20,
    moisture_bps: 1250,
    custodian: Keypair.random().publicKey(),
    verifier: Keypair.random().publicKey(),
    deposited_at: 1_759_600_000,
    at: 1_759_708_799,
    salt: randomBytes(32).toString('hex'),
    ...overrides,
  };
}

/** Runs functions from the published standalone verifier, unchanged. */
function python(code: string, input: unknown): string {
  const script = verifyProofScript();
  return execFileSync(
    'python3',
    [
      '-c',
      `import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("vp", ${JSON.stringify(script)})
vp = importlib.util.module_from_spec(spec); spec.loader.exec_module(vp)
data = json.load(sys.stdin)
${code}`,
    ],
    { input: JSON.stringify(input) },
  )
    .toString()
    .trim();
}

describe('merkle', () => {
  it.skipIf(SCRIPT === null)('hashes a leaf exactly as scripts/verify_proof.py does', () => {
    const leaves = [
      leaf(),
      leaf({ kind: 0, kg: 0, bags: 1, weight_source: 'BagEstimate' }),
      leaf({ receipt_id: 12, receipt_version: 3, deposit_no: 2 ** 40 }),
    ];
    for (const l of leaves) {
      expect(python('print(vp.leaf_hash(data).hex())', l)).toBe(entryHash(l).toString('hex'));
    }
  });

  it('folds proofs and chains heads exactly as the standalone verifier does', () => {
    const hashes = Array.from({ length: 11 }, () => entryHash(leaf()));
    const tree = buildTree(hashes);
    for (const index of [0, 5, 10]) {
      const proof = tree.proofs[index] ?? [];
      if (SCRIPT !== null) {
        const folded = python(
          'print(vp.fold(bytes.fromhex(data["h"]), data["i"], [bytes.fromhex(p) for p in data["p"]]).hex())',
          {
            h: hashes[index]?.toString('hex'),
            i: index,
            p: proof.map((p) => p.toString('hex')),
          },
        );
        expect(folded).toBe(tree.root.toString('hex'));
      }
      expect(foldProof(hashes[index] as Buffer, index, proof).equals(tree.root)).toBe(true);
      expect(proof).toHaveLength(depthFor(11));
    }
    if (SCRIPT !== null) {
      const head = python(
        'print(vp.chain(bytes(32), data["d"], data["n"], bytes.fromhex(data["r"])).hex())',
        { d: 20_366, n: 11, r: tree.root.toString('hex') },
      );
      expect(head).toBe(nextHead(ZERO_HEAD, 20_366, 11, tree.root).toString('hex'));
    }
  });

  it('pads to a power of two with sha256(0x00), and a one-leaf tree is its leaf', () => {
    const one = entryHash(leaf());
    expect(buildTree([one])).toEqual({ root: one, proofs: [[]] });
    const [a, b, c] = [one, entryHash(leaf()), entryHash(leaf())];
    const tree = buildTree([a, b, c]);
    expect(tree.proofs[2]?.[0]).toEqual(PADDING);
    expect(PADDING).toEqual(sha256(Buffer.from([0])));
    expect([1, 2, 3, 4, 5, 2048, 2049].map(depthFor)).toEqual([0, 1, 2, 2, 3, 11, 12]);
  });

  it('gives a book record a hash no leaf with the same values has', () => {
    const l = leaf({ kind: 1 });
    const record: BookRecordJson = {
      record: 'adjustment',
      version: 1,
      warehouse_id: l.warehouse_id,
      day: l.day,
      index: l.index,
      deposit_no: l.deposit_no,
      deposit_id: l.deposit_id,
      source_id: 'a1',
      reason: 'spoilage',
      owner: l.owner,
      bags_delta: -1,
      kg_delta: -100,
      at: l.at,
      salt: l.salt,
    };
    expect(entryHash(record)).not.toEqual(entryHash(l));
    expect(entryHash(record)).toEqual(entryHash({ ...record }));
  });

  it('orders leaves by kind then deposit_no, breaking ties by time and source', () => {
    const at = (kind: 0 | 1 | 2, depositNo: number, time: number, sourceId: string) => ({
      entry: { ...leaf({ kind, deposit_no: depositNo, at: time }) },
      sourceId,
    });
    const items = [
      at(2, 1, 9, 'x'),
      at(1, 3, 5, 'b'),
      at(1, 3, 5, 'a'),
      at(0, 9, 1, 'z'),
      at(1, 3, 4, 'c'),
    ];
    const sorted = [...items].sort(compareEntries).map((o) => o.sourceId);
    expect(sorted).toEqual(['z', 'c', 'a', 'b', 'x']);
  });

  it('puts adjustment then cancellation records after every leaf, and compares source ids as bytes (protocol #8)', () => {
    const record = (kind: 'adjustment' | 'cancellation', sourceId: string) => ({
      entry: { record: kind, deposit_no: 1, at: 5 },
      sourceId,
    });
    const balance = { entry: { ...leaf({ kind: 2, deposit_no: 9, at: 9 }) }, sourceId: 'z' };
    const items = [
      record('cancellation', 'c1'),
      // UTF-16 puts U+1F600 (a surrogate pair, 0xD83D…) before U+FF61; UTF-8 bytes do not.
      record('adjustment', '\u{1F600}'),
      record('adjustment', '\uFF61'),
      balance,
    ];
    const sorted = [...items].sort(compareEntries).map((o) => o.sourceId);
    expect(sorted).toEqual(['z', '\uFF61', '\u{1F600}', 'c1']);
  });
});
