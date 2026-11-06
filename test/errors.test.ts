import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { errorHandler } from '../src/http/errorHandler.js';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../src/http/errors.js';
import { requestLogger } from '../src/http/requestLogger.js';
import { createLogger } from '../src/logger.js';
import type { ErrorBody } from './helpers/http.js';

function appThrowing(error: unknown) {
  const app = express();
  app.use(requestLogger(createLogger('silent')));
  app.get('/boom', () => {
    throw error;
  });
  app.get('/async-boom', async () => {
    await Promise.resolve();
    throw error;
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it.each([
    [new NotFoundError('Deposit not found'), 404, 'not_found'],
    [new ConflictError('Deposit already recorded'), 409, 'conflict'],
    [new ServiceUnavailableError('Try later'), 503, 'service_unavailable'],
  ])('maps %s to its status and code', async (error, status, code) => {
    const res = await request(appThrowing(error)).get('/boom');
    expect(res.status).toBe(status);
    expect((res.body as ErrorBody).error).toEqual({ code, message: error.message });
  });

  it('includes details when the error has them', async () => {
    const error = new ConflictError('Deposit already recorded', {
      details: { depositId: 'dep-0001' },
    });
    const res = await request(appThrowing(error)).get('/boom');
    expect((res.body as ErrorBody).error.details).toEqual({ depositId: 'dep-0001' });
  });

  it('handles errors thrown from async handlers', async () => {
    const res = await request(appThrowing(new NotFoundError('gone'))).get('/async-boom');
    expect(res.status).toBe(404);
  });

  it('hides the message of unexpected errors', async () => {
    const res = await request(appThrowing(new Error('password=hunter2 leaked'))).get('/boom');
    expect(res.status).toBe(500);
    expect((res.body as ErrorBody).error).toEqual({
      code: 'internal_error',
      message: 'Internal server error',
    });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('sets typed error names', () => {
    expect(new ConflictError('x').name).toBe('ConflictError');
  });
});
