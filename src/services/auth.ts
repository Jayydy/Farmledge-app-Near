import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type pg from 'pg';

import { withTransaction } from '../db/transaction.js';
import type { Queryable } from '../db/pool.js';
import { normaliseNigerianMobile } from '../domain/phone.js';
import { PIN_LOCKOUT_MINUTES, PIN_MAX_FAILED_ATTEMPTS, validatePin } from '../domain/pin.js';
import {
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../http/errors.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** scrypt cost: ~32 MB and tens of milliseconds per check, per OWASP guidance. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_BYTES = 32;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** `scrypt$N$r$p$<salt b64>$<hash b64>` */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pin, salt, KEY_BYTES, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')]
    .map(String)
    .join('$');
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(pin, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(actual, expected);
}

/** Checked against when the phone is unknown, so timing doesn't reveal which phones are staff. */
const DECOY_HASH = hashPin('000000');

export const tokenDigest = (token: string): Buffer => createHash('sha256').update(token).digest();

/** The signed-in custodian a request acts as. */
export interface StaffSession {
  readonly sessionId: string;
  readonly custodianId: string;
  readonly warehouseId: string;
  readonly expiresAt: Date;
}

/** What the tablet needs to work at its warehouse: who is signed in, and who can verify. */
export interface SessionView {
  session: { id: string; expires_at: Date };
  custodian: { id: string; full_name: string; phone: string };
  warehouse: { id: string; code: string; name: string };
  /** Active verifiers assigned to the warehouse (D44), for verifier_id. Names only: no phones. */
  roster: { verifiers: { id: string; full_name: string }[] };
}

export interface SignInView extends SessionView {
  /** The bearer token. Shown once; only its SHA-256 is stored. */
  token: string;
}

interface CustodianRow {
  id: string;
  warehouse_id: string;
  status: string;
  pin_hash: string | null;
  pin_failed_attempts: number;
  pin_locked_until: Date | null;
  warehouse_status: string;
}

const invalidCredentials = () =>
  new UnauthorizedError('Phone number or PIN is wrong', { code: 'invalid_credentials' });

export class AuthService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly sessionTtlHours: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Signs a custodian in with phone and PIN. Every failure that could tell
   * an attacker something (unknown phone, no PIN set, suspended, wrong PIN)
   * is the same 401. After PIN_MAX_FAILED_ATTEMPTS wrong PINs in a row the
   * custodian is locked out for PIN_LOCKOUT_MINUTES.
   */
  async signIn(phone: string, pin: string): Promise<SignInView> {
    const normalised = normaliseNigerianMobile(phone);
    if (!normalised.ok) {
      await verifyPin(pin, await DECOY_HASH);
      throw invalidCredentials();
    }
    const now = this.clock();

    const outcome = await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<CustodianRow>(
        `SELECT c.id, c.warehouse_id, c.status, c.pin_hash, c.pin_failed_attempts,
                c.pin_locked_until, w.status AS warehouse_status
           FROM custodians c JOIN warehouses w ON w.id = c.warehouse_id
          WHERE c.phone = $1
            FOR UPDATE OF c`,
        [normalised.value],
      );
      const custodian = rows[0];
      if (custodian?.pin_hash == null) {
        await verifyPin(pin, await DECOY_HASH);
        return { kind: 'invalid' as const };
      }
      if (custodian.pin_locked_until !== null && custodian.pin_locked_until > now) {
        return { kind: 'locked' as const, until: custodian.pin_locked_until };
      }
      const pinOk = await verifyPin(pin, custodian.pin_hash);
      if (!pinOk) {
        const attempts = custodian.pin_failed_attempts + 1;
        const lock = attempts >= PIN_MAX_FAILED_ATTEMPTS;
        await client.query(
          `UPDATE custodians SET pin_failed_attempts = $2, pin_locked_until = $3 WHERE id = $1`,
          [
            custodian.id,
            lock ? 0 : attempts,
            lock ? new Date(now.getTime() + PIN_LOCKOUT_MINUTES * MINUTE_MS) : null,
          ],
        );
        return { kind: 'invalid' as const };
      }
      if (custodian.status !== 'active' || custodian.warehouse_status !== 'active') {
        return { kind: 'invalid' as const };
      }
      await client.query(
        `UPDATE custodians SET pin_failed_attempts = 0, pin_locked_until = NULL
          WHERE id = $1 AND (pin_failed_attempts <> 0 OR pin_locked_until IS NOT NULL)`,
        [custodian.id],
      );
      const token = randomBytes(32).toString('base64url');
      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO staff_sessions (token_sha256, custodian_id, warehouse_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          tokenDigest(token),
          custodian.id,
          custodian.warehouse_id,
          new Date(now.getTime() + this.sessionTtlHours * HOUR_MS),
          now,
        ],
      );
      const sessionId = created[0]?.id;
      if (sessionId === undefined) throw new Error('session insert returned no row');
      return { kind: 'ok' as const, token, sessionId };
    });

    if (outcome.kind === 'locked') {
      throw new TooManyRequestsError(
        `Too many wrong PINs; try again in ${PIN_LOCKOUT_MINUTES} minutes`,
        { retryAfterSeconds: Math.ceil((outcome.until.getTime() - now.getTime()) / 1000) },
      );
    }
    if (outcome.kind === 'invalid') throw invalidCredentials();
    const view = await this.view(this.pool, outcome.sessionId);
    return { token: outcome.token, ...view };
  }

  /** The live session behind a bearer token, or null if unknown, expired, revoked or suspended. */
  async authenticate(token: string): Promise<StaffSession | null> {
    const { rows } = await this.pool.query<{
      id: string;
      custodian_id: string;
      warehouse_id: string;
      expires_at: Date;
    }>(
      `SELECT s.id, s.custodian_id, s.warehouse_id, s.expires_at
         FROM staff_sessions s
         JOIN custodians c ON c.id = s.custodian_id AND c.warehouse_id = s.warehouse_id
         JOIN warehouses w ON w.id = s.warehouse_id
        WHERE s.token_sha256 = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
          AND c.status = 'active' AND w.status = 'active'`,
      [tokenDigest(token), this.clock()],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      sessionId: row.id,
      custodianId: row.custodian_id,
      warehouseId: row.warehouse_id,
      expiresAt: row.expires_at,
    };
  }

  /** The session again, with a fresh roster. */
  async current(session: StaffSession): Promise<SessionView> {
    return this.view(this.pool, session.sessionId);
  }

  async signOut(session: StaffSession): Promise<void> {
    await this.pool.query(
      'UPDATE staff_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
      [session.sessionId, this.clock()],
    );
  }

  /** Sets a custodian's PIN (CLI only) and clears any lockout. Existing sessions stay valid. */
  async setPin(phone: string, pin: string): Promise<{ id: string; full_name: string }> {
    const errors = [];
    const normalised = normaliseNigerianMobile(phone);
    if (!normalised.ok) errors.push(...normalised.errors);
    const valid = validatePin(pin);
    if (!valid.ok) errors.push(...valid.errors);
    if (!normalised.ok || errors.length > 0) {
      throw new ValidationError('PIN could not be set', { details: errors });
    }
    const { rows } = await this.pool.query<{ id: string; full_name: string }>(
      `UPDATE custodians
          SET pin_hash = $2, pin_failed_attempts = 0, pin_locked_until = NULL
        WHERE phone = $1
        RETURNING id, full_name`,
      [normalised.value, await hashPin(pin)],
    );
    const custodian = rows[0];
    if (custodian === undefined) throw new NotFoundError('No custodian has that phone number');
    return custodian;
  }

  private async view(db: Queryable, sessionId: string): Promise<SessionView> {
    const { rows } = await db.query<{
      id: string;
      expires_at: Date;
      custodian_id: string;
      full_name: string;
      phone: string;
      warehouse_id: string;
      code: string;
      name: string;
    }>(
      `SELECT s.id, s.expires_at, c.id AS custodian_id, c.full_name, c.phone,
              w.id AS warehouse_id, w.code, w.name
         FROM staff_sessions s
         JOIN custodians c ON c.id = s.custodian_id
         JOIN warehouses w ON w.id = s.warehouse_id
        WHERE s.id = $1`,
      [sessionId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`session ${sessionId} not found`);
    const verifiers = await db.query<{ id: string; full_name: string }>(
      `SELECT v.id, v.full_name
         FROM verifiers v
         JOIN verifier_warehouses vw ON vw.verifier_id = v.id
        WHERE vw.warehouse_id = $1 AND vw.status = 'active' AND v.status = 'active'
        ORDER BY v.full_name, v.id`,
      [row.warehouse_id],
    );
    return {
      session: { id: row.id, expires_at: row.expires_at },
      custodian: { id: row.custodian_id, full_name: row.full_name, phone: row.phone },
      warehouse: { id: row.warehouse_id, code: row.code, name: row.name },
      roster: { verifiers: verifiers.rows },
    };
  }
}
