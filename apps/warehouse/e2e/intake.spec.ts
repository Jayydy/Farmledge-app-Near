import { expect, test } from '@playwright/test';

import { E2E } from './env';
import { query, recordDeposit, signIn } from './helpers';

test('records a deposit end to end against the local API', async ({ page }) => {
  await page.goto('/');
  await signIn(page);

  const depositId = await recordDeposit(page, {
    farmerPhone: E2E.farmerPhone,
    moisture: '12.5',
    bags: '20',
    sample: { bags: '2', kg: '198.5' },
    photos: 2,
  });

  // The screen moves from "saved on the tablet" to "received by the server".
  await expect(page.getByTestId('save-state')).toHaveText('Received by the server.');
  await expect(page.getByTestId('status')).toContainText('All sent');
  // The slip now carries the leaf and salt from GET /deposits/:id/slip.
  await expect(
    page.locator('p.hint', { hasText: /holds this deposit's record and salt/ }),
  ).toBeVisible();

  const [deposit] = await query<{
    farmer_phone: string;
    custodian: string;
    grade: string;
    moisture_bps: number;
    bag_count: number;
    photos: number;
    samples: number;
  }>(
    `SELECT f.phone AS farmer_phone, c.phone AS custodian, d.grade, d.moisture_bps, d.bag_count,
            (SELECT count(*)::int FROM deposit_photos p WHERE p.deposit_id = d.deposit_id) AS photos,
            (SELECT count(*)::int FROM scale_samples s
              WHERE s.deposit_id = d.deposit_id AND s.sample_id IS NOT NULL) AS samples
       FROM deposits d JOIN farmers f ON f.id = d.farmer_id JOIN custodians c ON c.id = d.custodian_id
      WHERE d.deposit_id = $1`,
    [depositId],
  );
  expect(deposit).toEqual({
    farmer_phone: '+2348031234567',
    custodian: E2E.custodianPhone,
    grade: '2',
    moisture_bps: 1250,
    bag_count: 20,
    photos: 2,
    samples: 1,
  });
});
