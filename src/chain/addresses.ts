import type { KeyService } from '../keys/keyService.js';
import type { ChainBackend } from './chainClient.js';
import {
  encodeStellarEd25519PublicKey,
  isValidStellarEd25519PublicKey,
} from './stellarAddress.js';

/**
 * Key-service subjects for the keys Farmledge holds, and the chain
 * addresses they sign as. There is deliberately no subject for a lender:
 * lenders hold their own keys and we never derive, store or use one (D31).
 */
export const OPERATOR_SUBJECT = 'platform:operator';

export const subjectOf = {
  farmer: (id: string) => `farmer:${id}`,
  custodian: (id: string) => `custodian:${id}`,
  verifier: (id: string) => `verifier:${id}`,
};

/** The only subject kinds a key service may hold. */
export const MANAGED_SUBJECT =
  /^(platform:operator|(farmer|custodian|verifier):[A-Za-z0-9-]{1,64})$/;

/**
 * Valid NEAR account ID (2–64 chars, lowercase alphanumeric + `.`, `_`, `-`
 * in interior positions; includes 64-char hex implicit accounts and named
 * accounts such as `lender.testnet`).
 */
export const NEAR_ACCOUNT_RE = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;

export async function addressFor(
  keys: KeyService,
  subject: string,
  backend: ChainBackend = 'stellar',
): Promise<string> {
  const pubHex = (await keys.publicKey(subject)).toLowerCase();
  if (backend === 'near') {
    // NEAR implicit account ID is the 64-char lowercase hex of the 32-byte Ed25519 public key.
    return pubHex;
  }
  return encodeStellarEd25519PublicKey(Buffer.from(pubHex, 'hex'));
}

export function isValidAccount(address: string, backend: ChainBackend = 'stellar'): boolean {
  if (backend === 'near') {
    if (!NEAR_ACCOUNT_RE.test(address)) return false;
    // Reject consecutive separators (`..`, `--`, `__`) per NEAR account ID grammar.
    if (/[._-]{2}/.test(address)) return false;
    return true;
  }
  return isValidStellarEd25519PublicKey(address);
}
