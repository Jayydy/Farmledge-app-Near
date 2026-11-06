import { expect, test } from '@playwright/test';

import { E2E } from './env';
import { keypad, next, query, signIn } from './helpers';

/**
 * A faded slip, replaced in seconds by any staff member: a deposit recorded
 * by another tablet (straight through the API), found here by the number on
 * the slip and by the farmer's phone, and printed with a reprint stamp.
 */
test('reprints a slip recorded on another tablet', async ({ page, request }) => {
  // "Another tablet": the same custodian records a deposit through the API.
  const signInRes = await request.post(`http://localhost:${E2E.apiPort}/auth/sessions`, {
    data: { phone: E2E.custodianPhone, pin: E2E.pin },
  });
  const { token, roster } = (await signInRes.json()) as {
    token: string;
    roster: { verifiers: { id: string }[] };
  };
  const [farmer] = await query<{ id: string; custodian: string }>(
    `SELECT f.id, c.id AS custodian FROM farmers f, custodians c
      WHERE f.phone = '+2348031234567' AND c.phone = $1`,
    [E2E.custodianPhone],
  );
  const depositId = crypto.randomUUID();
  const created = await request.post(`http://localhost:${E2E.apiPort}/deposits`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      deposit_id: depositId,
      farmer_id: farmer?.id,
      warehouse_id: E2E.warehouseId,
      custodian_id: farmer?.custodian,
      verifier_id: roster.verifiers[0]?.id,
      commodity: 'MAIZE_YELLOW',
      grade: 3,
      moisture_pct: 12,
      bag_count: 33,
    },
  });
  expect(created.status()).toBe(201);
  const { deposit } = (await created.json()) as { deposit: { deposit_no: number } };

  await page.addInitScript(() => {
    (window as unknown as { prints: number }).prints = 0;
    window.print = () => {
      (window as unknown as { prints: number }).prints++;
    };
  });
  await page.goto('/');
  await signIn(page);

  // By the number on the slip.
  await page.getByRole('button', { name: /Reprint a slip/ }).click();
  await page.getByRole('button', { name: 'By deposit number' }).click();
  await keypad(page, String(deposit.deposit_no));
  await next(page);
  await expect(page.getByTestId('reprint-result')).toHaveCount(1);
  await expect(page.getByTestId('reprint-result')).toContainText('Musa Bello');
  await page.getByRole('button', { name: /Print/ }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { prints: number }).prints))
    .toBe(1);
  const slip = page.getByTestId('slip');
  await expect(slip).toContainText('DEPOSIT SLIP');
  await expect(slip).toContainText(`Deposit no. ${deposit.deposit_no}`);
  await expect(slip).toContainText('Yellow maize');
  await expect(page.getByTestId('reprint-stamp')).toContainText('REPRINT');
  await expect(page.getByTestId('reprint-stamp')).toContainText('Amina Sani');

  // And by the farmer's phone: the same deposit is among their deposits.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: "By farmer's phone" }).click();
  await keypad(page, E2E.farmerPhone);
  await next(page);
  await expect(
    page.getByTestId('reprint-result').filter({ hasText: `Deposit no. ${deposit.deposit_no}` }),
  ).toHaveCount(1);
});
