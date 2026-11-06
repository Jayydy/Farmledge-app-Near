import { createHash, createPrivateKey, createPublicKey, hkdfSync, sign } from 'node:crypto';

import { MANAGED_SUBJECT } from '../chain/addresses.js';
import type { Queryable } from '../db/pool.js';
import type { KeyService, SignContext } from './keyService.js';

/**
 * Only the platform operator, farmers, custodians and verifiers have keys
 * here. Anything else, a lender above all, is refused: we never hold a
 * lender's key, so no code path can sign on a lender's behalf (D31).
 */
function assertManaged(subject: string): void {
  if (!MANAGED_SUBJECT.test(subject)) {
    throw new Error(`no key is held for "${subject}"; only managed subjects can sign`);
  }
}

/** DER prefix that wraps a raw 32-byte Ed25519 seed as a PKCS#8 private key. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * KEY_SERVICE=local_dev. Derives each subject's Ed25519 key from
 * KEY_SERVICE_LOCAL_SECRET with HKDF, so no private key is ever stored.
 * The environment is part of the derivation, so test and live keys differ
 * even with one secret. For development and the Testnet pilot only.
 */
export class LocalDevKeyService implements KeyService {
  constructor(
    private readonly secret: string,
    private readonly environment: string,
    private readonly db: Queryable,
  ) {}

  publicKey(subject: string): Promise<string> {
    try {
      return Promise.resolve(this.publicKeyHex(subject));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async sign(subject: string, payload: Buffer, context: SignContext): Promise<string> {
    assertManaged(subject);
    const signature = sign(null, payload, this.privateKey(subject)).toString('hex');
    await this.db.query(
      `INSERT INTO key_signature_log (key_subject, public_key, purpose, payload_sha256, device_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        subject,
        this.publicKeyHex(subject),
        context.purpose,
        createHash('sha256').update(payload).digest('hex'),
        context.deviceId ?? null,
      ],
    );
    return signature;
  }

  private privateKey(subject: string) {
    assertManaged(subject);
    const seed = Buffer.from(
      hkdfSync('sha256', this.secret, `farmledge:${this.environment}`, `ed25519:${subject}`, 32),
    );
    return createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
  }

  private publicKeyHex(subject: string): string {
    const jwk = createPublicKey(this.privateKey(subject)).export({ format: 'jwk' });
    return Buffer.from(jwk.x ?? '', 'base64url').toString('hex');
  }
}
