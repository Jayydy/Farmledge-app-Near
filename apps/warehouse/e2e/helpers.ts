import { readFileSync } from 'node:fs';

import { expect, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';

import { E2E, STATE_FILE } from './env';

/** Queries the throwaway database the API is using. */
export async function query<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { databaseUrl } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { databaseUrl: string };
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** Presses on-screen keypad keys, one per character. */
export async function keypad(page: Page, text: string) {
  for (const key of text) {
    await page.locator(`.keypad__key[aria-label="${key}"]`).click();
  }
}

export const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true }).click();

export async function signIn(page: Page) {
  await expect(page.getByRole('heading', { name: 'Staff sign-in' })).toBeVisible();
  await keypad(page, '08000000001');
  await next(page);
  await keypad(page, E2E.pin);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: /New deposit/ })).toBeVisible();
}

export async function unlock(page: Page) {
  await expect(page.getByRole('heading', { name: 'Locked' })).toBeVisible();
  await keypad(page, E2E.pin);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('button', { name: /New deposit/ })).toBeVisible();
}

/** Counts records in one of the tablet's IndexedDB stores. */
export function countLocal(page: Page, store: string): Promise<number> {
  return page.evaluate(
    (name) =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('farmledge-warehouse');
        open.onsuccess = () => {
          const request = open.result.transaction(name).objectStore(name).count();
          request.onsuccess = () => {
            resolve(request.result);
          };
        };
      }),
    store,
  );
}

/** A real JPEG, drawn by the browser, for the camera input. */
export async function jpeg(page: Page, seed: number): Promise<Buffer> {
  const base64 = await page.evaluate((hue) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no canvas');
    context.fillStyle = `hsl(${hue}, 60%, 50%)`;
    context.fillRect(0, 0, 640, 480);
    context.fillStyle = '#fff';
    context.fillText(`bags ${hue}`, 40, 40);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1] ?? '';
  }, seed * 37);
  return Buffer.from(base64, 'base64');
}

export interface IntakeInput {
  farmerPhone: string;
  /** Set to register a new farmer. */
  newFarmerName?: string;
  moisture: string;
  bags: string;
  sample?: { bags: string; kg: string };
  photos: number;
}

/** Walks the whole intake flow and confirms; returns the deposit_id from the tablet. */
export async function recordDeposit(page: Page, input: IntakeInput): Promise<string> {
  await page.getByRole('button', { name: /New deposit/ }).click();

  await expect(page.getByRole('heading', { name: "Farmer's phone number" })).toBeVisible();
  await keypad(page, input.farmerPhone);
  await next(page);
  if (input.newFarmerName === undefined) {
    await expect(page.getByRole('heading', { name: 'Is this the farmer?' })).toBeVisible();
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Register farmer' }).click();
    await page.getByRole('textbox', { name: "Farmer's full name" }).fill(input.newFarmerName);
    await next(page);
    await page.getByRole('button', { name: 'Farmer agrees' }).click();
    await page.getByRole('button', { name: 'No', exact: true }).click();
  }

  await page.getByRole('button', { name: 'White maize' }).click();
  await page.getByRole('button', { name: 'Grade 2' }).click();
  await keypad(page, input.moisture);
  await next(page);
  await keypad(page, input.bags);
  await next(page);
  await page.getByRole('button', { name: 'Bala Musa' }).click();

  if (input.sample === undefined) {
    await page.getByRole('button', { name: 'Skip' }).click();
  } else {
    await page.getByRole('button', { name: 'Weigh a sample' }).click();
    await keypad(page, input.sample.bags);
    await next(page);
    await keypad(page, input.sample.kg);
    await next(page);
  }

  for (let i = 0; i < input.photos; i++) {
    await page.getByTestId('photo-input').setInputFiles({
      name: `bags-${i}.jpg`,
      mimeType: 'image/jpeg',
      buffer: await jpeg(page, i + 1),
    });
    await expect(page.getByRole('img', { name: `Photos ${i + 1}` })).toBeVisible();
  }
  await next(page);

  await expect(
    page.getByRole('heading', { name: 'Check everything with the farmer' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm deposit' }).click();
  await expect(page.getByTestId('success')).toBeVisible();

  // The deposit the tablet just saved: the newest local record.
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('farmledge-warehouse');
        open.onerror = () => {
          reject(new Error('cannot open IndexedDB'));
        };
        open.onsuccess = () => {
          const all = open.result.transaction('deposits').objectStore('deposits').getAll();
          all.onsuccess = () => {
            const records = all.result as { deposit_id: string; captured_at: string }[];
            records.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
            resolve(records.at(-1)?.deposit_id ?? '');
          };
        };
      }),
  );
}

// ---- Dispatch and balance fixtures --------------------------------------------------

const apiUrl = (path: string) => `http://localhost:${E2E.apiPort}${path}`;

export interface Staff {
  token: string;
  custodianId: string;
  verifierId: string;
}

/** Signs the demo custodian in straight through the API ("another tablet"). */
export async function apiSignIn(request: APIRequestContext): Promise<Staff> {
  const res = await request.post(apiUrl('/auth/sessions'), {
    data: { phone: E2E.custodianPhone, pin: E2E.pin },
  });
  const body = (await res.json()) as {
    token: string;
    custodian: { id: string };
    roster: { verifiers: { id: string }[] };
  };
  return {
    token: body.token,
    custodianId: body.custodian.id,
    verifierId: body.roster.verifiers[0]?.id ?? '',
  };
}

/** A farmer of their own per test, so balances from other specs never mix in. */
export async function registerFarmer(
  request: APIRequestContext,
  staff: Staff,
  phone: string,
  fullName: string,
): Promise<string> {
  const res = await request.post(apiUrl('/farmers'), {
    headers: { Authorization: `Bearer ${staff.token}` },
    data: {
      full_name: fullName,
      phone,
      warehouse_id: E2E.warehouseId,
      registered_by: staff.custodianId,
      consent: true,
    },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { farmer: { id: string } }).farmer.id;
}

/** One lot of yellow maize grade 1; returns its id and number. */
export async function depositLot(
  request: APIRequestContext,
  staff: Staff,
  farmerId: string,
  bags: number,
): Promise<{ depositId: string; depositNo: number }> {
  const depositId = crypto.randomUUID();
  const res = await request.post(apiUrl('/deposits'), {
    headers: { Authorization: `Bearer ${staff.token}` },
    data: {
      deposit_id: depositId,
      farmer_id: farmerId,
      warehouse_id: E2E.warehouseId,
      custodian_id: staff.custodianId,
      verifier_id: staff.verifierId,
      commodity: 'MAIZE_YELLOW',
      grade: 1,
      moisture_pct: 12,
      bag_count: bags,
    },
  });
  expect(res.status()).toBe(201);
  const { deposit } = (await res.json()) as { deposit: { deposit_no: number } };
  return { depositId, depositNo: deposit.deposit_no };
}

/**
 * Puts a lot under a mint, as a pledge does (INV-1): `pledged` leaves the
 * mint pending (frozen); `minted` gives it a receipt (INV-6). The e2e API
 * runs without a chain, so this is the database state a pledge leaves.
 */
export async function governLot(
  depositId: string,
  state: 'pledged' | 'minted',
  receiptId = 12,
): Promise<void> {
  const [request] = await query<{ id: string }>(
    `INSERT INTO mint_requests (deposit_id, warehouse_id, anchor_day, book_entry_id, status, receipt_id)
     VALUES ($1, $2, 0, gen_random_uuid(), $3, $4) RETURNING id`,
    [
      depositId,
      E2E.warehouseId,
      state === 'minted' ? 'minted' : 'pending',
      state === 'minted' ? receiptId : null,
    ],
  );
  await query(
    state === 'minted'
      ? `UPDATE deposits SET frozen_for_mint = $2, status = 'minted', chain_receipt_id = $3 WHERE deposit_id = $1`
      : `UPDATE deposits SET frozen_for_mint = $2 WHERE deposit_id = $1`,
    state === 'minted' ? [depositId, request?.id, receiptId] : [depositId, request?.id],
  );
}

/** Replaces window.print with a counter; read it with `prints(page)`. */
export async function countPrints(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { prints: number }).prints = 0;
    window.print = () => {
      (window as unknown as { prints: number }).prints++;
    };
  });
}

export const prints = (page: Page) =>
  page.evaluate(() => (window as unknown as { prints: number }).prints);
