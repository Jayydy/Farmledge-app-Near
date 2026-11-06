/**
 * Signing keys for custodians, verifiers and the platform (design doc §6).
 * Private keys never leave the implementation; callers get public keys and
 * signatures, and every signature is logged.
 */
export interface KeyService {
  /** Hex Ed25519 public key for `subject`, e.g. `custodian:<uuid>`. */
  publicKey(subject: string): Promise<string>;
  /** Hex Ed25519 signature of `payload`, logged with its purpose and device. */
  sign(subject: string, payload: Buffer, context: SignContext): Promise<string>;
}

export interface SignContext {
  /** Why it was signed, e.g. `mint_cosign`. */
  readonly purpose: string;
  readonly deviceId?: string | undefined;
}
