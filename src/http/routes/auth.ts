import { Router } from 'express';
import { z } from 'zod';

import type { AuthService } from '../../services/auth.js';
import { signedInStaff } from '../auth.js';
import { parseBody } from '../parse.js';

const signInBody = z.object({ phone: z.string(), pin: z.string() });

/**
 * POST   /auth/sessions          sign in with phone and PIN; returns a bearer token and the roster
 * GET    /auth/sessions/current  the session and a fresh roster
 * DELETE /auth/sessions/current  sign out (revokes the token)
 */
export function authRouter(auth: AuthService): Router {
  const router = Router();

  router.post('/auth/sessions', async (req, res) => {
    const body = parseBody(signInBody, req.body);
    res
      .status(201)
      .set('Cache-Control', 'no-store')
      .json(await auth.signIn(body.phone, body.pin));
  });

  router.get('/auth/sessions/current', async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await auth.current(signedInStaff(req)));
  });

  router.delete('/auth/sessions/current', async (req, res) => {
    await auth.signOut(signedInStaff(req));
    res.status(204).end();
  });

  return router;
}
