import { expect, test, type APIRequestContext } from '@playwright/test';

import { E2E } from './env';
import {
  apiSignIn,
  countPrints,
  depositLot,
  keypad,
  next,
  prints,
  query,
  registerFarmer,
  signIn,
  type Staff,
} from './helpers';

/**
 * Home's Today panel, the daily summary and the stock count (D57) against
 * the local API. Other specs share the database, so figures are checked
 * against what the API itself reports, not against fixed totals.
 */
const apiUrl = (path: string) => `http://localhost:${E2E.apiPort}${path}`;
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());

async function apiGet<T>(request: APIRequestContext, staff: Staff, path: string): Promise<T> {
  const res = await request.get(apiUrl(path), {
    headers: { Authorization: `Bearer ${staff.token}` },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as T;
}

test('Today and the daily summary: warehouse-wide in and out, unweighed and blocked dispatches', async ({
  page,
  request,
}) => {
  const staff = await apiSignIn(request);
  const auth = { Authorization: `Bearer ${staff.token}` };
  const farmerId = await registerFarmer(request, staff, '+2349080000101', 'Sadiq Umar');
  const lot = await depositLot(request, staff, farmerId, 8);
  const dispatched = await request.post(apiUrl('/dispatches'), {
    headers: auth,
    data: {
      dispatch_id: crypto.randomUUID(),
      warehouse_id: E2E.warehouseId,
      farmer_id: farmerId,
      custodian_id: staff.custodianId,
      commodity: 'MAIZE_YELLOW',
      grade: '1',
      bag_count: 3,
      not_weighed_reason: 'Scale broken',
      farmer_confirmed: true,
    },
  });
  expect(dispatched.status()).toBe(201);
  // Blocked on some other tablet at this warehouse.
  const blockedRes = await request.post(apiUrl(`/warehouses/${E2E.warehouseId}/dispatch-blocked`), {
    headers: auth,
    data: {
      id: crypto.randomUUID(),
      custodian_id: staff.custodianId,
      blocked_at: new Date().toISOString(),
    },
  });
  expect(blockedRes.status()).toBe(201);
  const { blocked } = await apiGet<{ blocked: number }>(
    request,
    staff,
    `/warehouses/${E2E.warehouseId}/dispatch-blocked?from=${today()}&to=${today()}`,
  );

  await countPrints(page);
  await page.goto('/');
  await signIn(page);

  const panel = page.getByTestId('today');
  await expect(panel.getByTestId('today-in')).toContainText('bags');
  await expect(panel.getByTestId('today-out')).toContainText('dispatches');
  await expect(panel.getByTestId('today-not-weighed')).toContainText('Dispatches out not weighed:');
  await expect(panel.getByTestId('today-blocked')).toHaveText(
    `⚠ Dispatches blocked offline, whole warehouse: ${blocked}`,
  );

  await panel.getByRole('button', { name: 'Daily summary' }).click();
  await expect(page.getByTestId('summary-date')).toHaveText(today());
  await expect(page.getByTestId('summary-deposits')).toContainText(`Deposit no. ${lot.depositNo}`);
  await expect(page.getByTestId('summary-dispatches')).toContainText('Not weighed: Scale broken');
  await expect(page.getByTestId('summary-blocked')).toHaveText(
    `Dispatches blocked offline, whole warehouse: ${blocked}`,
  );
  await expect(page.getByTestId('summary-stock')).toContainText('Yellow maize · Grade 1');

  // Yesterday has none of today's records, and tomorrow is never offered.
  await page.getByRole('button', { name: '‹ Previous day' }).click();
  await expect(page.getByTestId('summary-in')).toBeVisible();
  await expect(page.getByText(`Deposit no. ${lot.depositNo}`)).toHaveCount(0);
  await expect(page.getByTestId('summary-stock')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next day ›' }).click();
  await expect(page.getByRole('button', { name: 'Next day ›' })).toBeDisabled();

  await page.getByRole('button', { name: /Print summary/ }).click();
  await expect.poll(() => prints(page)).toBe(1);
  await expect(page.getByTestId('summary-slip')).toContainText('DAILY SUMMARY');
});

test('stock count: counter and witness named, blind entry, survives the lock, then the report', async ({
  page,
  request,
}) => {
  const staff = await apiSignIn(request);
  const farmerId = await registerFarmer(request, staff, '+2349080000102', 'Zainab Isa');
  await depositLot(request, staff, farmerId, 6);
  const stock = await apiGet<{ lines: { commodity: string; grade: string; bags: number }[] }>(
    request,
    staff,
    `/warehouses/${E2E.warehouseId}/stock`,
  );
  const recorded =
    stock.lines.find((l) => l.commodity === 'MAIZE_YELLOW' && l.grade === '1')?.bags ?? 0;
  expect(recorded).toBeGreaterThan(0);

  await countPrints(page);
  await page.goto('/');
  await signIn(page);
  await page.getByTestId('today').getByRole('button', { name: 'Stock count' }).click();

  // The custodian who manages the stock can't be its witness.
  await page.getByLabel('Counted by').fill('Musa Bello');
  await page.getByLabel('Witnessed by').fill('amina  SANI');
  await expect(
    page.getByText('You manage this stock, so you cannot be the witness.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start count' })).toBeDisabled();
  await page.getByLabel('Witnessed by').fill('Hauwa Sani');
  await page.getByRole('button', { name: 'Start count' }).click();

  await page.getByRole('button', { name: 'Yellow maize' }).click();
  await page.getByRole('button', { name: 'Grade 1', exact: true }).click();
  await next(page);
  // Blind: nothing recorded is on screen until the count is saved.
  await expect(page.getByText('Recorded', { exact: true })).toHaveCount(0);
  await keypad(page, String(recorded - 1));
  await next(page);
  await page.getByRole('button', { name: 'Save count' }).click();
  const saved = page.getByTestId('saved-line');
  await expect(saved.getByTestId('recorded')).toContainText(`${recorded} bags`);
  await expect(saved.getByTestId('counted')).toContainText(`${recorded - 1} bags`);
  await expect(saved.getByTestId('difference')).toContainText('−1 /');

  // The idle lock, or anyone locking, doesn't lose the open count.
  await page.getByRole('button', { name: /Lock/ }).click();
  await expect(page.getByRole('heading', { name: 'Locked' })).toBeVisible();
  await keypad(page, E2E.pin);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  // Back where the custodian was, with the count still open.
  await expect(page.getByTestId('counted-lines').locator('li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByTestId('today').getByRole('button', { name: 'Continue stock count' }).click();
  await expect(page.getByTestId('counted-lines').locator('li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Yellow maize' }).click();
  await expect(page.getByRole('button', { name: /Grade 1/ })).toBeDisabled();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Finish count' }).click();
  const report = page.getByTestId('count-report');
  await expect(report).toContainText('Counted by: Musa Bello · Witnessed by: Hauwa Sani');
  await expect(report.getByTestId('names-not-verified')).toHaveText(
    'Names recorded, not verified: typed on the tablet, not signed by the people named.',
  );
  await expect(report.getByTestId('report-line')).toHaveCount(1);
  await page.getByRole('button', { name: /Print report/ }).click();
  await expect.poll(() => prints(page)).toBe(1);
  await expect(page.getByTestId('count-slip')).toContainText('STOCK COUNT');
  await expect(page.getByTestId('count-slip')).toContainText('Names recorded, not verified');

  const rows = await query<{
    entered_by: string;
    counted_by: string;
    witnessed_by: string;
    status: string;
  }>(
    `SELECT entered_by, counted_by, witnessed_by, status FROM audits
      WHERE warehouse_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [E2E.warehouseId],
  );
  expect(rows).toEqual([
    {
      entered_by: staff.custodianId,
      counted_by: 'Musa Bello',
      witnessed_by: 'Hauwa Sani',
      status: 'completed',
    },
  ]);

  // Finished: Home offers a new count, not a continuation.
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(
    page.getByTestId('today').getByRole('button', { name: 'Stock count' }),
  ).toBeVisible();
});
