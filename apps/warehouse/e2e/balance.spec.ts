import { expect, test } from '@playwright/test';

import {
  apiSignIn,
  countPrints,
  depositLot,
  governLot,
  keypad,
  prints,
  registerFarmer,
  signIn,
} from './helpers';

/**
 * Farmer balance lookup against the local API: current figures online with
 * fees and recent movements; offline only the tablet's 24-hour copy, shown
 * with its age and never as current; two taps from Home for a farmer looked
 * up before.
 */
test('online: free versus held on-chain, fees owed and recent movements; printable; two taps next time', async ({
  page,
  request,
}) => {
  const staff = await apiSignIn(request);
  const farmerId = await registerFarmer(request, staff, '+2349080000001', 'Rakiya Bala');
  const pledged = await depositLot(request, staff, farmerId, 7);
  await depositLot(request, staff, farmerId, 5);
  await governLot(pledged.depositId, 'pledged');

  await countPrints(page);
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Farmer balance' }).click();
  await keypad(page, '09080000001');
  await page.getByRole('button', { name: 'Find', exact: true }).click();

  const screen = page.getByTestId('balance');
  await expect(screen).toHaveAttribute('data-current', 'true');
  await expect(page.getByTestId('balance-age')).toContainText('Current, as of');
  const line = page.getByTestId('balance-line');
  await expect(line).toHaveCount(1);
  await expect(line).toContainText('Yellow maize · Grade 1');
  await expect(line).toContainText('12 bags, 1,200 kg');
  await expect(line.getByTestId('free')).toHaveText('5 bags, 500 kg');
  await expect(line.getByTestId('held')).toHaveText('7 bags, 700 kg');
  await expect(line).toContainText(`Held on-chain (lot ${pledged.depositNo})`);
  await expect(page.getByTestId('fees-owed')).toHaveText('₦0.00');
  await expect(page.getByTestId('movements').locator('li')).toHaveCount(2);

  await page.getByRole('button', { name: /Print statement/ }).click();
  await expect.poll(() => prints(page)).toBe(1);
  const slip = page.getByTestId('balance-slip');
  await expect(slip).toContainText('STATEMENT');
  await expect(slip).toContainText('Rakiya Bala');
  await expect(slip).toContainText('Storage fees owed');
  await expect(page.getByTestId('not-current')).toHaveCount(0);

  // Next time: Farmer balance, then the farmer. Two taps.
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Farmer balance' }).click();
  await page.getByTestId('recent-farmer').filter({ hasText: 'Rakiya Bala' }).click();
  await expect(page.getByTestId('balance')).toHaveAttribute('data-current', 'true');
});

test('offline: cached figures with their age, greyed, never as current, without fees; the slip says NOT CURRENT', async ({
  page,
  context,
  request,
}) => {
  const staff = await apiSignIn(request);
  const farmerId = await registerFarmer(request, staff, '+2349080000002', 'Sani Lawal');
  await depositLot(request, staff, farmerId, 9);
  await registerFarmer(request, staff, '+2349080000003', 'Never Lookedup');

  await countPrints(page);
  await page.goto('/');
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await signIn(page);
  await expect(page.getByTestId('status')).toContainText('All sent');

  // Looked up once online: that is what the tablet may keep.
  await page.getByRole('button', { name: 'Farmer balance' }).click();
  await keypad(page, '09080000002');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByTestId('balance')).toHaveAttribute('data-current', 'true');
  await page.getByRole('button', { name: 'Another farmer' }).click();

  await context.setOffline(true);
  await expect(page.getByTestId('status')).toContainText('Offline');
  await page.getByTestId('recent-farmer').filter({ hasText: 'Sani Lawal' }).click();

  const screen = page.getByTestId('balance');
  await expect(screen).toHaveAttribute('data-current', 'false');
  await expect(page.getByTestId('balance-age')).toHaveText(
    /^OFFLINE: as of .+ \(\d+ min ago\)\. May have changed\.$/,
  );
  await expect(page.getByTestId('balance-line')).toContainText('9 bags, 900 kg');
  await expect(page.getByTestId('balance-line')).toHaveCSS('opacity', '0.55');
  await expect(page.getByTestId('fees-owed')).toHaveCount(0);
  await expect(page.getByTestId('movements')).toHaveCount(0);
  await expect(screen).toContainText('Fees and movements are not kept on this tablet.');

  await page.getByRole('button', { name: /Print statement/ }).click();
  await expect.poll(() => prints(page)).toBe(1);
  await expect(page.getByTestId('not-current')).toContainText('NOT CURRENT — as of');
  await expect(page.getByTestId('balance-slip')).not.toContainText('Storage fees owed');

  // A farmer never looked up on this tablet: nothing to show offline.
  await page.getByRole('button', { name: 'Another farmer' }).click();
  await keypad(page, '09080000003');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByTestId('balance')).toContainText('No balance can be shown.');
});
