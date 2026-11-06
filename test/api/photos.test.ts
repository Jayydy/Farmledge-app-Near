import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { depositBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

/** A few bytes that start like each format; the API checks signatures, not full decoding. */
const jpeg = (seed: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(seed)]);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png body'),
]);

interface PhotoBody {
  photo: { id: string; sha256: string; size_bytes: number; content_type: string };
  duplicate: boolean;
}

describe('photos API', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi();
  });

  afterAll(async () => {
    await api.close();
  });

  const createDeposit = async () => {
    const body = depositBody(api.fixtures);
    await request(api.app).post('/deposits').send(body).expect(201);
    return body.deposit_id;
  };
  const upload = (
    depositId: string,
    data: Buffer,
    contentType = 'image/jpeg',
    uploadedBy: string = api.fixtures.custodianId,
  ) =>
    request(api.app)
      .post(`/deposits/${depositId}/photos`)
      .query({ uploaded_by: uploadedBy })
      .set('Content-Type', contentType)
      .send(data);

  it('stores a photo on disk and serves it back', async () => {
    const depositId = await createDeposit();
    const data = jpeg('first');

    const res = await upload(depositId, data);
    expect(res.status).toBe(201);
    const { photo } = res.body as PhotoBody;
    expect(photo).toMatchObject({ content_type: 'image/jpeg', size_bytes: data.length });

    const onDisk = await readFile(
      path.join(api.photoDir, photo.sha256.slice(0, 2), `${photo.sha256}.jpg`),
    );
    expect(onDisk.equals(data)).toBe(true);

    const fetched = await request(api.app)
      .get(`/deposits/${depositId}/photos/${photo.id}`)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          done(null, Buffer.concat(chunks));
        });
      });
    expect(fetched.status).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/jpeg');
    expect((fetched.body as Buffer).equals(data)).toBe(true);

    const deposit = await request(api.app).get(`/deposits/${depositId}`);
    expect((deposit.body as { deposit: { photo_count: number } }).deposit.photo_count).toBe(1);
  });

  it('allows up to 3 photos and refuses a 4th', async () => {
    const depositId = await createDeposit();
    await upload(depositId, jpeg('a')).expect(201);
    await upload(depositId, png, 'image/png').expect(201);
    await upload(depositId, jpeg('c')).expect(201);

    const res = await upload(depositId, jpeg('d'));
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error.code).toBe('photo_limit_reached');

    const list = await request(api.app).get(`/deposits/${depositId}/photos`);
    expect((list.body as { items: unknown[] }).items).toHaveLength(3);
  });

  it('holds the limit under concurrent uploads', async () => {
    const depositId = await createDeposit();
    const responses = await Promise.all(
      ['1', '2', '3', '4', '5'].map((seed) => upload(depositId, jpeg(seed))),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 201, 409, 409]);
  });

  it('recognises a retried upload of the same image instead of using a slot', async () => {
    const depositId = await createDeposit();
    const first = await upload(depositId, jpeg('same'));
    const retry = await upload(depositId, jpeg('same'));

    expect(retry.status).toBe(200);
    expect((retry.body as PhotoBody).duplicate).toBe(true);
    expect((retry.body as PhotoBody).photo.id).toBe((first.body as PhotoBody).photo.id);
  });

  it('rejects unsupported and mislabelled files', async () => {
    const depositId = await createDeposit();

    const pdf = await upload(depositId, Buffer.from('%PDF-1.7 ...'), 'application/pdf');
    expect(pdf.status).toBe(415);
    expect((pdf.body as ErrorBody).error.code).toBe('unsupported_media_type');

    const lying = await upload(depositId, Buffer.from('%PDF-1.7 ...'), 'image/jpeg');
    expect(lying.status).toBe(415);

    const mismatched = await upload(depositId, png, 'image/jpeg');
    expect((mismatched.body as ErrorBody).error.message).toBe(
      'The file is not a valid image/jpeg image (it looks like image/png)',
    );

    const empty = await upload(depositId, Buffer.alloc(0));
    expect(empty.status).toBe(400);
  });

  it('rejects photos over the size limit (5 MB in tests)', async () => {
    const depositId = await createDeposit();
    const res = await upload(
      depositId,
      Buffer.concat([jpeg('big'), Buffer.alloc(5 * 1024 * 1024)]),
    );
    expect(res.status).toBe(413);
    expect((res.body as ErrorBody).error.code).toBe('payload_too_large');
  });

  it('requires an uploader from the deposit’s warehouse', async () => {
    const depositId = await createDeposit();
    const missing = await request(api.app)
      .post(`/deposits/${depositId}/photos`)
      .set('Content-Type', 'image/jpeg')
      .send(jpeg('x'));
    expect((missing.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'required', field: 'uploaded_by' }),
    ]);

    const wrong = await upload(depositId, jpeg('x'), 'image/jpeg', api.fixtures.otherCustodianId);
    expect((wrong.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'custodian_wrong_warehouse', field: 'uploaded_by' }),
    ]);
  });

  it('returns 404 for unknown deposits and photos', async () => {
    await upload(randomUUID(), jpeg('x')).expect(404);
    await request(api.app).get(`/deposits/${randomUUID()}/photos`).expect(404);
    const depositId = await createDeposit();
    await request(api.app).get(`/deposits/${depositId}/photos/${randomUUID()}`).expect(404);
    await request(api.app).get(`/deposits/${depositId}/photos/nope`).expect(404);
  });
});
