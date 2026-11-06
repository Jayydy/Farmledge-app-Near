import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The standalone proof verifier, from outside this repo: the app does not
 * own a verifier. farmledge-protocol's scripts/verify_proof.py is canonical;
 * farmledge-verify ships the same file, pinned to it by sha256. CI checks
 * out farmledge-verify at a pinned commit and sets FARMLEDGE_VERIFY_PROOF.
 * Locally, a sibling checkout of either repo is found.
 */
export function verifyProofScript(): string {
  const candidates = [
    process.env.FARMLEDGE_VERIFY_PROOF,
    path.resolve(import.meta.dirname, '../../../farmledge-protocol/scripts/verify_proof.py'),
    path.resolve(import.meta.dirname, '../../../farmledge-verify/scripts/verify_proof.py'),
  ];
  const found = candidates.find((c): c is string => c !== undefined && existsSync(c));
  if (found === undefined) {
    throw new Error(
      'verify_proof.py not found: set FARMLEDGE_VERIFY_PROOF, or check out farmledge-protocol or farmledge-verify beside this repo',
    );
  }
  return found;
}
