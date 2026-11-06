/**
 * Unlocking offline: after an online sign-in the tablet keeps a PBKDF2 hash
 * of the PIN (never the PIN), so the same custodian can unlock without
 * signal. The server's own check (scrypt, lockout) is what guards sign-in;
 * this only guards the tablet's lock screen, and is wiped after
 * MAX_FAILED_UNLOCKS wrong tries, forcing an online sign-in.
 */
export const PIN_CHECK_ITERATIONS = 310_000;
export const MAX_FAILED_UNLOCKS = 5;

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function makePinCheck(
  pin: string,
  iterations = PIN_CHECK_ITERATIONS,
): Promise<{ salt: string; hash: string; iterations: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: toBase64(salt), hash: toBase64(await derive(pin, salt, iterations)), iterations };
}

export async function verifyPinCheck(
  pin: string,
  check: { salt: string; hash: string; iterations: number },
): Promise<boolean> {
  if (check.hash === '') return false;
  const actual = await derive(pin, fromBase64(check.salt), check.iterations);
  const expected = fromBase64(check.hash);
  // Constant time over the full length.
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  }
  return diff === 0;
}
