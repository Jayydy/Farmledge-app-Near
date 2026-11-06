import { StrKey } from '@stellar/stellar-sdk';

import type { KeyService } from '../keys/keyService.js';

/**
 * Key-service subjects for the keys Farmledge holds, and the Stellar
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

export async function addressFor(keys: KeyService, subject: string): Promise<string> {
  return StrKey.encodeEd25519PublicKey(Buffer.from(await keys.publicKey(subject), 'hex'));
}
