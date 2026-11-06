/**
 * Where intake photo bytes live. The database keeps only the key, so the
 * backing store (local disk now, object storage later) can change without
 * touching the services.
 */
export interface PhotoStore {
  /** Stores `data` under `key`. Writing the same key again is a harmless no-op. */
  put(key: string, data: Buffer): Promise<void>;
  /** The bytes under `key`, or null if nothing is stored there. */
  get(key: string): Promise<Buffer | null>;
}

/** Keys are relative paths of lower-case letters, digits, `.`, `-`, `_` and `/`, never `..`. */
const SAFE_KEY = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*\.[a-z0-9]+$/;

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key)) {
    throw new Error(`unsafe photo storage key: ${key}`);
  }
}
