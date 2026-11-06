import { StrKey } from '@stellar/stellar-sdk';

export function encodeStellarEd25519PublicKey(rawPublicKey: Buffer): string {
  return StrKey.encodeEd25519PublicKey(rawPublicKey);
}

export function isValidStellarEd25519PublicKey(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}
