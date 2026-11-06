import { expect, test, type Page } from '@playwright/test';

import { E2E } from './env';
import {
  apiSignIn,
  countLocal,
  countPrints,
  depositLot,
  governLot,
  keypad,
  next,
  prints,
  query,
  registerFarmer,
  signIn,
} from './helpers';

/**
 * Dispatch against the local API (D54). Each test has its own farmer with
 * four lots of yellow maize grade 1, oldest first: 10 bags minted (receipt
 * #12), 8 pledged with the mint pending, then 6 and 4 free.
 */
async function farmerWithLots(
  request: Parameters<typeof apiSignIn>[0],
  phone: string,
  name: string,
) {
  const staff = await apiSignIn(request);
  const farmerId = await registerFarmer(request, staff, phone, name);
  const minted = await depositLot(request, staff, farmerId, 10);
  const pledged = await depositLot(request, staff, farmerId, 8);
  const older = await depositLot(request, staff, farmerId, 6);
  const newer = await depositLot(request, staff, farmerId, 4);
  await governLot(minted.depositId, 'minted', 12);
  await governLot(pledged.depositId, 'pledged');
  return { staff, farmerId, minted, pledged, older, newer };
}

/** Home → Dispatch → farmer → the yellow maize grade 1 line → bags. */
async function startDispatch(page: Page, localPhone: string) {
  await page.getByRole('button', { name: /^Dispatch/ }).click();
  await expect(page.getByRole('heading', { name: "Farmer's phone number" })).toBeVisible();
  await keypad(page, localPhone);
  await next(page);
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What do they want to take out?' })).toBeVisible();
  const line = page.getByTestId('holding').filter({ hasText: 'Yellow maize' });
  await expect(line).toContainText('10 bags free');
  await expect(line).toContainText('18 more bags are held on-chain');
  await line.click();
}

async function signOff(page: Page) {
  await page.getByRole('button', { name: 'Farmer confirms' }).click();
  await expect(page.getByRole('heading', { name: /sign off with your PIN/ })).toBeVisible();
  await keypad(page, E2E.pin);
  await page.getByRole('button', { name: 'Sign off and dispatch' }).click();
}

test('draws oldest free lots first, shows excluded lots with reasons, refuses beyond the free balance, and prints the note', async ({
  page,
  request,
}) => {
  const f = await farmerWithLots(request, '+2349070000001', 'Zainab Yusuf');
  await countPrints(page);
  await page.goto('/');
  await signIn(page);
  await startDispatch(page, '09070000001');

  // Step 3: more than the free balance can't go further, and says why.
  await expect(page.getByText('Step 3 of 7')).toBeVisible();
  await expect(page.getByTestId('free-bags')).toHaveText('10 bags free · 18 held on-chain');
  await keypad(page, '11');
  await expect(page.getByTestId('over-free')).toContainText(
    'Only 10 bags are free to dispatch. 18 more are pledged or minted',
  );
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await page.locator('.keypad__key[aria-label="Delete"]').click();
  await page.locator('.keypad__key[aria-label="Delete"]').click();
  await keypad(page, '8');
  await next(page);

  // Step 4: the server's plan, oldest first, and every lot of the grade, excluded ones with reasons.
  await expect(page.getByText('Step 4 of 7')).toBeVisible();
  await expect(page.getByTestId('plan')).toHaveText(
    `Oldest lots first: lot ${f.older.depositNo}: 6 bags, lot ${f.newer.depositNo}: 2 bags`,
  );
  const lots = page.getByTestId('lot');
  await expect(lots).toHaveCount(4);
  await expect(lots.nth(0)).toHaveAttribute('data-state', 'minted');
  await expect(lots.nth(0).getByTestId('lot-reason')).toHaveText(
    'Minted as receipt #12: governed on-chain, so this lot cannot leave here.',
  );
  await expect(lots.nth(1)).toHaveAttribute('data-state', 'pledged');
  await expect(lots.nth(1).getByTestId('lot-reason')).toHaveText(
    'Pledged: a receipt is being minted, so this lot is frozen and cannot leave here.',
  );
  await expect(lots.nth(2)).toContainText('Bags come from here');
  await expect(lots.nth(3)).toContainText('Bags come from here');
  await next(page);

  // Step 5: the weight actually released.
  await keypad(page, '790.5');
  await next(page);
  await expect(page.getByTestId('dispatch-review')).toContainText(
    `lot ${f.older.depositNo}: 6 bags, lot ${f.newer.depositNo}: 2 bags`,
  );
  await signOff(page);

  // Recorded: only now is there a delivery note to print.
  await expect(page.getByTestId('dispatch-done')).toBeVisible();
  await expect(page.getByText('Release 8 bags now.')).toBeVisible();
  const noteNo = (await page.getByTestId('delivery-note-no').textContent()) ?? '';
  expect(noteNo).toMatch(/^KN-DEMO-DN-\d{6}$/);
  await page.getByRole('button', { name: /Print delivery note/ }).click();
  await expect.poll(() => prints(page)).toBe(1);
  const note = page.getByTestId('delivery-note');
  await expect(note).toContainText('DELIVERY NOTE');
  await expect(note).toContainText(noteNo);
  await expect(note).toContainText('790.5 kg');
  await expect(note).toContainText(`lot ${f.older.depositNo}: 6 bags`);

  const [row] = await query<{ bag_count: number; exit_weight_kg: string; drawn: string }>(
    `SELECT d.bag_count, d.exit_weight_kg::text,
            (SELECT string_agg(dep.deposit_no || ':' || (-lm.bags_delta), ',' ORDER BY dep.deposit_no)
               FROM stock_movements sm JOIN lot_movements lm ON lm.stock_movement_id = sm.id
               JOIN deposits dep ON dep.deposit_id = lm.deposit_id WHERE sm.dispatch_id = d.id) AS drawn
       FROM dispatches d WHERE d.delivery_note_no = $1`,
    [noteNo],
  );
  expect(row).toEqual({
    bag_count: 8,
    exit_weight_kg: '790.50',
    drawn: `${f.older.depositNo}:6,${f.newer.depositNo}:2`,
  });
});

test('takes the bags from a lot the custodian chooses, and records "not weighed" with its reason', async ({
  page,
  request,
}) => {
  const f = await farmerWithLots(request, '+2349070000002', 'Ibrahim Garba');
  await page.goto('/');
  await signIn(page);
  await startDispatch(page, '09070000002');
  await keypad(page, '3');
  await next(page);

  await page.getByRole('button', { name: 'Choose a specific lot' }).click();
  const choices = page.getByTestId('lot-choice');
  await expect(choices).toHaveCount(4);
  // Excluded and too-small lots are shown, but can't be chosen.
  await expect(choices.nth(0)).toHaveAttribute('aria-disabled', 'true');
  await expect(choices.nth(1)).toHaveAttribute('aria-disabled', 'true');
  await expect(choices.nth(3)).toHaveAttribute('aria-disabled', 'false');
  await choices.nth(3).click();
  await expect(page.getByTestId('plan')).toHaveText(
    `From the chosen lot: lot ${f.newer.depositNo}: 3 bags`,
  );
  await next(page);

  await page.getByRole('button', { name: 'Not weighed' }).click();
  await page.getByRole('button', { name: 'Scale not working' }).click();
  await expect(page.getByTestId('dispatch-review')).toContainText('Not weighed: Scale not working');
  await signOff(page);
  await expect(page.getByTestId('dispatch-done')).toBeVisible();

  const rows = await query<{
    exit_weight_kg: string | null;
    not_weighed_reason: string;
    requested: string;
  }>(
    `SELECT exit_weight_kg, not_weighed_reason, requested_deposit_id AS requested
       FROM dispatches WHERE farmer_id = $1`,
    [f.farmerId],
  );
  expect(rows).toEqual([
    { exit_weight_kg: null, not_weighed_reason: 'Scale not working', requested: f.newer.depositId },
  ]);
});

test('a lot pledged after the plan: the server refuses, and the tablet shows the lots again with the reason', async ({
  page,
  request,
}) => {
  const f = await farmerWithLots(request, '+2349070000003', 'Halima Sule');
  await page.goto('/');
  await signIn(page);
  await startDispatch(page, '09070000003');
  await keypad(page, '8');
  await next(page);
  await expect(page.getByTestId('plan')).toContainText(`lot ${f.older.depositNo}: 6 bags`);
  await next(page);
  await keypad(page, '780');
  await next(page);

  // Meanwhile a pledge freezes the oldest free lot.
  await governLot(f.older.depositId, 'pledged');
  await signOff(page);

  await expect(page.getByText('Step 4 of 7')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(
    'The farmer does not have that many free bags now.',
  );
  await expect(page.getByTestId('lot').nth(2)).toHaveAttribute('data-state', 'pledged');
  expect(await query('SELECT 1 FROM dispatches WHERE farmer_id = $1', [f.farmerId])).toEqual([]);
});

test('offline in the shadow trial: blocked and counted, never told to hold grain; a lost answer is settled by reading the dispatch', async ({
  page,
  context,
  request,
}) => {
  const f = await farmerWithLots(request, '+2349070000004', 'Musa Danjuma');
  await countPrints(page);
  await page.goto('/');
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await signIn(page);
  await expect(page.getByTestId('status')).toContainText('All sent');

  // Offline: the dispatch never starts, and the attempt is recorded. The paper
  // record is binding (RELEASE_AUTHORITY=paper), so nobody is told to hold grain.
  await context.setOffline(true);
  await expect(page.getByTestId('status')).toContainText('Offline');
  await expect(page.getByRole('button', { name: /^Dispatch/ })).toContainText('Needs a connection');
  await page.getByRole('button', { name: /^Dispatch/ }).click();
  const blocked = page.getByTestId('dispatch-blocked');
  await expect(blocked).toContainText(
    'Farmledge can’t record a dispatch without a connection. Release as the warehouse normally does',
  );
  await expect(blocked).not.toContainText('Do not release');
  await expect(blocked).toContainText('Dispatches blocked on this tablet: 1');
  expect(await countLocal(page, 'outbox')).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Home', exact: true }).click();

  // Back online: the record reaches the API, with no farmer or lot in it.
  await context.setOffline(false);
  await expect(page.getByTestId('status')).toContainText('All sent', { timeout: 60_000 });
  const [custodian] = await query<{ id: string }>('SELECT id FROM custodians WHERE phone = $1', [
    E2E.custodianPhone,
  ]);
  await expect
    .poll(async () =>
      query('SELECT custodian_id FROM dispatch_blocked_events WHERE custodian_id = $1', [
        custodian?.id,
      ]),
    )
    .toHaveLength(1);

  // 1st send: the server records it and the answer never arrives. 2nd: a 401,
  // which proves nothing about the 1st, so the tablet reads the dispatch.
  await startDispatch(page, '09070000004');
  await keypad(page, '2');
  await next(page);
  await next(page);
  await keypad(page, '196');
  await next(page);
  let posts = 0;
  await page.route('**/api/dispatches', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    posts++;
    if (posts === 1) {
      await route.fetch();
      await route.abort('connectionreset');
    } else {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'session_invalid', message: 'Session has ended' } }),
      });
    }
  });
  await signOff(page);

  const unconfirmed = page.getByTestId('dispatch-unconfirmed');
  await expect(unconfirmed).toContainText('Not confirmed');
  await expect(page.getByTestId('release-rule')).toHaveText(
    'Release as the warehouse normally does. Farmledge is still confirming this dispatch; any difference is settled at the next stock audit.',
  );
  await expect(page.getByTestId('dispatch-reference')).toHaveText(/^X-[0-9A-F]{4}-[0-9A-F]{4}$/);
  expect(await prints(page)).toBe(0);

  // Read-to-resolve: the dispatch exists, so it is recorded; once, and printable now.
  await expect(page.getByTestId('dispatch-done')).toBeVisible({ timeout: 60_000 });
  expect(posts).toBe(2);
  expect(
    await query<{ n: number }>('SELECT count(*)::int AS n FROM dispatches WHERE farmer_id = $1', [
      f.farmerId,
    ]),
  ).toEqual([{ n: 1 }]);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByTestId('pending-dispatches')).toHaveCount(0);
});

test('with RELEASE_AUTHORITY=farmledge the tablet says to hold the bags', async ({
  page,
  context,
  request,
}) => {
  await farmerWithLots(request, '+2349070000005', 'Aisha Kabir');
  // The same API, reporting the production rule.
  await page.route('**/api/features', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, release_authority: 'farmledge' } });
  });
  await page.goto('/');
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await signIn(page);
  await expect(page.getByTestId('status')).toContainText('All sent');

  await context.setOffline(true);
  await expect(page.getByTestId('status')).toContainText('Offline');
  await page.getByRole('button', { name: /^Dispatch/ }).click();
  await expect(page.getByTestId('dispatch-blocked')).toContainText(
    'Dispatch needs a connection: pledges and other dispatches must be checked first. Do not release any bags.',
  );
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await context.setOffline(false);
  await expect(page.getByTestId('status')).toContainText('All sent', { timeout: 60_000 });

  await startDispatch(page, '09070000005');
  await keypad(page, '1');
  await next(page);
  await next(page);
  await keypad(page, '98');
  await next(page);
  await page.route('**/api/dispatches', (route) =>
    route.request().method() === 'POST' ? route.abort('connectionreset') : route.fallback(),
  );
  await signOff(page);
  await expect(page.getByTestId('release-rule')).toHaveText(
    'Do not release the bags until this says the dispatch is recorded.',
  );
});

test('left pending after 5 minutes: survives a reload, shown on Home, settled from there', async ({
  page,
  request,
}) => {
  const f = await farmerWithLots(request, '+2349070000006', 'Yakubu Sani');
  await page.clock.install();
  await page.goto('/');
  await signIn(page);
  await startDispatch(page, '09070000006');
  await keypad(page, '3');
  await next(page);
  await next(page);
  await keypad(page, '294');
  await next(page);

  // No answer at all: the server never sees it.
  await page.route('**/api/dispatches', (route) =>
    route.request().method() === 'POST' ? route.abort('connectionreset') : route.fallback(),
  );
  await signOff(page);
  await expect(page.getByTestId('dispatch-unconfirmed')).toContainText(
    'If this is not confirmed within 5 minutes, you can leave it pending',
  );
  await expect(page.getByRole('button', { name: 'Leave pending' })).toHaveCount(0);
  const reference = (await page.getByTestId('dispatch-reference').textContent()) ?? '';

  // Five minutes at the counter (with a touch in between, as a custodian would).
  await page.clock.fastForward('04:00');
  await page.getByRole('heading', { name: 'Not confirmed' }).click();
  await page.clock.fastForward('01:30');
  await page.getByRole('button', { name: 'Leave pending' }).click();

  const banner = page.getByTestId('pending-dispatches');
  await expect(banner.getByTestId('pending-dispatch')).toContainText('Yakubu Sani');
  await expect(banner.getByTestId('pending-dispatch')).toContainText(reference);
  await expect(banner.getByTestId('pending-dispatch')).toContainText('Not confirmed');

  // A reload (or a crash) loses nothing.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Locked' })).toBeVisible();
  await keypad(page, E2E.pin);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByTestId('pending-dispatch')).toContainText(reference);
  expect(await query('SELECT 1 FROM dispatches WHERE farmer_id = $1', [f.farmerId])).toEqual([]);

  // Signal back: opened from Home, it is sent again and recorded.
  await page.unroute('**/api/dispatches');
  await page.getByTestId('pending-dispatch').click();
  await page.clock.fastForward('00:06');
  await expect(page.getByTestId('dispatch-done')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByTestId('pending-dispatches')).toHaveCount(0);
  expect(
    await query<{ n: number }>('SELECT count(*)::int AS n FROM dispatches WHERE farmer_id = $1', [
      f.farmerId,
    ]),
  ).toEqual([{ n: 1 }]);
});
