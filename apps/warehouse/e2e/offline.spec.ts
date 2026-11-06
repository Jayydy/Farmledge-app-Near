import { expect, test } from '@playwright/test';

import { E2E } from './env';
import { countLocal, query, recordDeposit, signIn, unlock } from './helpers';

/**
 * The explicit offline test: go offline, record two deposits (one for a
 * farmer registered offline), come back online, and check both reach the
 * API exactly once, with their photos and the new farmer, and that sending
 * again changes nothing.
 */
test('two deposits recorded offline land exactly once when back online', async ({
  page,
  context,
}) => {
  // First visit online: the service worker installs and the farmer list is cached.
  await page.goto('/');
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await signIn(page);
  await expect(page.getByTestId('status')).toContainText('All sent');
  await expect.poll(() => countLocal(page, 'farmers')).toBeGreaterThan(0);

  // No network at all from here: the app itself must come from the service worker.
  await context.setOffline(true);
  await page.reload();
  await unlock(page); // reopening the app always asks for the PIN, offline too
  await expect(page.getByTestId('status')).toContainText('Offline');

  const known = await recordDeposit(page, {
    farmerPhone: E2E.farmerPhone, // found in the offline cache
    moisture: '11.0',
    bags: '15',
    photos: 1,
  });
  await expect(page.getByTestId('save-state')).toHaveText(
    'Saved on this tablet. It will be sent when there is signal.',
  );
  await page.getByRole('button', { name: 'Home', exact: true }).click();

  const registered = await recordDeposit(page, {
    farmerPhone: '09012345678',
    newFarmerName: 'Hauwa Abdullahi',
    moisture: '13.0',
    bags: '8',
    sample: { bags: '1', kg: '99.25' },
    photos: 1,
  });
  await page.getByRole('button', { name: 'Home', exact: true }).click();

  // Nothing has reached the server, and the tablet says so.
  await expect(page.getByTestId('status')).toContainText('Offline');
  await expect(page.getByTestId('status')).toContainText('6 waiting to send');
  expect(
    await query('SELECT 1 FROM deposits WHERE deposit_id = ANY($1)', [[known, registered]]),
  ).toEqual([]);
  await page.getByRole('button', { name: 'Waiting to send' }).first().click();
  await expect(page.getByTestId('queue-group')).toHaveCount(2);

  // Back online: everything goes, once.
  await context.setOffline(false);
  await expect(page.getByTestId('status')).toContainText('All sent', { timeout: 60_000 });
  await expect(page.getByText('Everything has been sent.')).toBeVisible();

  const counts = async () =>
    query<{ deposits: number; photos: number; samples: number; farmers: number }>(
      `SELECT (SELECT count(*)::int FROM deposits WHERE deposit_id = ANY($1)) AS deposits,
              (SELECT count(*)::int FROM deposit_photos WHERE deposit_id = ANY($1)) AS photos,
              (SELECT count(*)::int FROM scale_samples WHERE deposit_id = ANY($1)) AS samples,
              (SELECT count(*)::int FROM farmers WHERE phone = '+2349012345678') AS farmers`,
      [[known, registered]],
    );
  expect(await counts()).toEqual([{ deposits: 2, photos: 2, samples: 1, farmers: 1 }]);

  const [newDeposit] = await query<{ full_name: string; captured: Date }>(
    `SELECT f.full_name, d.intake_at AS captured FROM deposits d JOIN farmers f ON f.id = d.farmer_id
      WHERE d.deposit_id = $1`,
    [registered],
  );
  expect(newDeposit?.full_name).toBe('Hauwa Abdullahi');

  // Reload and sync again: still exactly once.
  await page.reload();
  await unlock(page);
  await expect(page.getByTestId('status')).toContainText('All sent');
  expect(await counts()).toEqual([{ deposits: 2, photos: 2, samples: 1, farmers: 1 }]);
});
