import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { depositBody, startTestApi, type TestApi } from '../helpers/api.js';
import type { ErrorBody } from '../helpers/http.js';

interface AuditBody {
  audit: {
    id: string;
    status: string;
    warehouse_id: string;
    conducted_by: string | null;
    entered_by: string | null;
    counted_by: string;
    witnessed_by: string;
  };
}

describe('audits API', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startTestApi();
    // Recorded stock at the fixture warehouse:
    //   MAIZE_WHITE grade 1: 120 + 80 = 200 bags, 20 000 kg
    //   MAIZE_YELLOW grade 2: 50 bags, 5 000 kg
    //   MAIZE_WHITE grade 3: 10 bags, 1 000 kg (never counted below)
    //   plus a cancelled deposit that must not count.
    const deposits = [
      { bag_count: 120 },
      { bag_count: 80 },
      { bag_count: 50, commodity: 'MAIZE_YELLOW', grade: 2 },
      { bag_count: 10, grade: 3 },
      { bag_count: 400, confirm_bag_count: true },
    ];
    const ids: string[] = [];
    for (const overrides of deposits) {
      const body = depositBody(api.fixtures, overrides);
      await request(api.app).post('/deposits').send(body).expect(201);
      ids.push(body.deposit_id);
    }
    await api.pool.query(`UPDATE deposits SET status = 'cancelled' WHERE deposit_id = $1`, [
      ids[4],
    ]);
  });

  afterAll(async () => {
    await api.close();
  });

  const startAudit = (overrides: Record<string, unknown> = {}) =>
    request(api.app)
      .post('/audits')
      .send({
        warehouse_id: api.fixtures.warehouseId,
        conducted_by: api.fixtures.verifierId,
        counted_by: 'Musa Bello',
        witnessed_by: 'Hauwa Sani',
        ...overrides,
      });
  const addLine = (auditId: string, body: Record<string, unknown>) =>
    request(api.app).post(`/audits/${auditId}/lines`).send(body);

  it('reports recorded versus counted stock with differences and percentages', async () => {
    const started = await startAudit({ notes: 'Quarterly count' });
    expect(started.status).toBe(201);
    const { audit } = started.body as AuditBody;
    expect(audit).toMatchObject({ status: 'open', warehouse_id: api.fixtures.warehouseId });

    const white = await addLine(audit.id, {
      commodity: 'MAIZE_WHITE',
      grade: 1,
      counted_bags: 198,
      counted_kg: 19750.5,
    });
    expect(white.status).toBe(201);
    expect(white.body).toMatchObject({
      line: {
        recorded_bags: 200,
        recorded_kg: 20000,
        counted_bags: 198,
        counted_kg: 19750.5,
        counted_kg_estimated: false,
        variance_bags: -2,
        variance_kg: -249.5,
      },
    });

    // Bags only: counted kg is taken as 51 × 100.
    const yellow = await addLine(audit.id, {
      commodity: 'MAIZE_YELLOW',
      grade: 2,
      counted_bags: 51,
    });
    expect(yellow.body).toMatchObject({ line: { counted_kg: 5100, counted_kg_estimated: true } });

    const report = await request(api.app).get(`/audits/${audit.id}/report`);
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({
      audit: { id: audit.id, status: 'open', notes: 'Quarterly count' },
      lines: [
        {
          commodity: 'MAIZE_WHITE',
          grade: '1',
          recorded_bags: 200,
          counted_bags: 198,
          difference_bags: -2,
          difference_bags_pct: -1,
          recorded_kg: 20000,
          counted_kg: 19750.5,
          difference_kg: -249.5,
          difference_kg_pct: -1.25,
        },
        {
          commodity: 'MAIZE_YELLOW',
          grade: '2',
          recorded_bags: 50,
          counted_bags: 51,
          difference_bags: 1,
          difference_bags_pct: 2,
          recorded_kg: 5000,
          counted_kg: 5100,
          difference_kg: 100,
          difference_kg_pct: 2,
        },
      ],
      totals: {
        recorded_bags: 250,
        counted_bags: 249,
        difference_bags: -1,
        difference_bags_pct: -0.4,
        recorded_kg: 25000,
        counted_kg: 24850.5,
        difference_kg: -149.5,
        difference_kg_pct: -0.6,
      },
      uncounted: [
        {
          commodity: 'MAIZE_WHITE',
          grading_scheme: 'provisional',
          grade: '3',
          recorded_bags: 10,
          recorded_kg: 1000,
        },
      ],
    });
  });

  it('snapshots recorded stock when a line is added', async () => {
    const { audit } = (await startAudit()).body as AuditBody;
    await addLine(audit.id, { commodity: 'MAIZE_WHITE', grade: 3, counted_bags: 10 }).expect(201);
    await request(api.app)
      .post('/deposits')
      .send(depositBody(api.fixtures, { grade: 3, bag_count: 5 }))
      .expect(201);

    const report = await request(api.app).get(`/audits/${audit.id}/report`);
    expect(report.body).toMatchObject({ lines: [{ recorded_bags: 10, difference_bags: 0 }] });
  });

  it('counts a line with no recorded stock with a null percentage', async () => {
    const { audit } = (await startAudit()).body as AuditBody;
    const line = await addLine(audit.id, { commodity: 'MAIZE_YELLOW', grade: 1, counted_bags: 3 });
    expect(line.body).toMatchObject({ line: { recorded_bags: 0, variance_bags: 3 } });
    const report = await request(api.app).get(`/audits/${audit.id}/report`);
    expect(report.body).toMatchObject({ lines: [{ difference_bags_pct: null }] });
  });

  it('refuses a second line for the same commodity and grade', async () => {
    const { audit } = (await startAudit()).body as AuditBody;
    const line = { commodity: 'MAIZE_WHITE', grade: 1, counted_bags: 200 };
    await addLine(audit.id, line).expect(201);
    const res = await addLine(audit.id, line);
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error.code).toBe('audit_line_exists');
  });

  it('closes an audit to further lines', async () => {
    const { audit } = (await startAudit()).body as AuditBody;
    const done = await request(api.app).post(`/audits/${audit.id}/complete`);
    expect(done.status).toBe(200);
    expect((done.body as AuditBody).audit.status).toBe('completed');

    const late = await addLine(audit.id, { commodity: 'MAIZE_WHITE', grade: 1, counted_bags: 1 });
    expect((late.body as ErrorBody).error.code).toBe('audit_completed');
    const again = await request(api.app).post(`/audits/${audit.id}/complete`);
    expect((again.body as ErrorBody).error.code).toBe('audit_completed');
  });

  it('validates audits and lines', async () => {
    const badStart = await startAudit({
      conducted_by: randomUUID(),
      started_at: '2020-01-01T00:00:00Z',
    });
    expect(
      ((badStart.body as ErrorBody).error.details as { code: string }[]).map((d) => d.code),
    ).toEqual(['captured_at_too_old', 'verifier_not_found']);

    const { audit } = (await startAudit()).body as AuditBody;
    const badLine = await addLine(audit.id, {
      commodity: 'RICE',
      grade: 9,
      counted_bags: -1,
      counted_kg: 1.001,
    });
    expect(
      ((badLine.body as ErrorBody).error.details as { code: string }[]).map((d) => d.code),
    ).toEqual(['unsupported_commodity', 'invalid_grade', 'invalid_counted_bags', 'invalid_kg']);
  });

  it('lets the custodian enter a count that names who counted and who witnessed', async () => {
    const res = await startAudit({
      conducted_by: undefined,
      entered_by: api.fixtures.custodianId,
      counted_by: '  Musa   Bello ',
    });
    expect(res.status).toBe(201);
    expect((res.body as AuditBody).audit).toMatchObject({
      conducted_by: null,
      entered_by: api.fixtures.custodianId,
      counted_by: 'Musa Bello',
      witnessed_by: 'Hauwa Sani',
    });
  });

  it('refuses a custodian of the warehouse as witness, however the name is typed', async () => {
    const res = await startAudit({
      entered_by: api.fixtures.custodianId,
      witnessed_by: ' test  CUSTODIAN ',
    });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'witness_is_custodian', field: 'witnessed_by' }),
    ]);
    // Another warehouse's custodian doesn't manage this stock.
    await startAudit({ witnessed_by: 'Other Custodian' }).expect(201);
  });

  it('needs who counted, who witnessed, and a custodian or verifier', async () => {
    const nobody = await startAudit({ conducted_by: undefined });
    expect((nobody.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'audit_actor_required' }),
    ]);
    const blank = await startAudit({ counted_by: ' ', witnessed_by: '' });
    expect(
      ((blank.body as ErrorBody).error.details as { code: string }[]).map((d) => d.code),
    ).toEqual(['invalid_counted_by', 'invalid_witnessed_by']);
    expect((await startAudit({ witnessed_by: undefined })).status).toBe(400);
    const elsewhere = await startAudit({ entered_by: api.fixtures.otherCustodianId });
    expect((elsewhere.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ code: 'custodian_wrong_warehouse', field: 'entered_by' }),
    ]);
  });

  it('returns 404 for unknown audits', async () => {
    await request(api.app).get(`/audits/${randomUUID()}/report`).expect(404);
    await request(api.app).get('/audits/nope/report').expect(404);
    await addLine(randomUUID(), { commodity: 'MAIZE_WHITE', grade: 1, counted_bags: 1 }).expect(
      404,
    );
    await request(api.app).post(`/audits/${randomUUID()}/complete`).expect(404);
  });
});
