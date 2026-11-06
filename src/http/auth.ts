import type { Request, RequestHandler } from 'express';

import type { AuthService, StaffSession } from '../services/auth.js';
import { ForbiddenError, UnauthorizedError } from './errors.js';

/**
 * Staff sessions (docs/decisions.md D41). `staffAuth` reads a bearer token
 * when one is sent; `requireStaff` guards the tablet's intake routes. With
 * a session, the acting custodian named in the body must be the signed-in
 * one, at their warehouse: the body still names them, but no longer
 * vouches for them.
 */

const sessions = new WeakMap<Request, StaffSession>();

/** The session the request is acting under, if any. */
export function staffOf(req: Request): StaffSession | undefined {
  return sessions.get(req);
}

export function staffAuth(auth: AuthService): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (header === undefined) {
      next();
      return;
    }
    const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
    const session = match?.[1] === undefined ? null : await auth.authenticate(match[1]);
    if (session === null) {
      throw new UnauthorizedError('Session has ended; sign in again', { code: 'session_invalid' });
    }
    sessions.set(req, session);
    next();
  };
}

/** The request's session; a 401 without one. */
export function signedInStaff(req: Request): StaffSession {
  const session = staffOf(req);
  if (session === undefined) {
    throw new UnauthorizedError('Sign in first', { code: 'authentication_required' });
  }
  return session;
}

/** 401 without a session, when `required`. */
export function requireStaff(required: boolean): RequestHandler {
  return (req, _res, next) => {
    if (required && staffOf(req) === undefined) {
      throw new UnauthorizedError('Sign in first', { code: 'authentication_required' });
    }
    next();
  };
}

export interface ActorClaim {
  /** The custodian the body names, and the field it came from. */
  readonly custodianId: string;
  readonly custodianField: string;
  /** The warehouse the body names, when it names one. */
  readonly warehouseId?: string | undefined;
  readonly warehouseField?: string | undefined;
}

/**
 * Null when the request has no session or the claim matches it; otherwise
 * the 403 to report. Non-throwing so a batch can reject one item.
 */
export function actorMismatch(req: Request, claim: ActorClaim): ForbiddenError | null {
  const session = staffOf(req);
  if (session === undefined) return null;
  const details = [];
  if (claim.custodianId.toLowerCase() !== session.custodianId) {
    details.push({
      code: 'actor_mismatch',
      field: claim.custodianField,
      message: `${claim.custodianField} must be the signed-in custodian`,
    });
  }
  if (claim.warehouseId !== undefined && claim.warehouseId.toLowerCase() !== session.warehouseId) {
    const field = claim.warehouseField ?? 'warehouse_id';
    details.push({
      code: 'actor_mismatch',
      field,
      message: `${field} must be the signed-in custodian's warehouse`,
    });
  }
  return details.length === 0
    ? null
    : new ForbiddenError('This session may not act for that custodian or warehouse', {
        code: 'actor_mismatch',
        details,
      });
}

export function assertActor(req: Request, claim: ActorClaim): void {
  const mismatch = actorMismatch(req, claim);
  if (mismatch !== null) throw mismatch;
}

/** With a session, a named warehouse must be the session's own (D46). */
export function assertOwnWarehouse(req: Request, warehouseId: string): void {
  const session = staffOf(req);
  if (session === undefined) return;
  assertActor(req, {
    custodianId: session.custodianId,
    custodianField: 'session',
    warehouseId,
    warehouseField: 'warehouse',
  });
}
