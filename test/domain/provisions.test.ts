import { createPublicKey, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AdapterUnavailableError,
  createChainClient,
  createConfirmation,
  createKeyService,
} from '../../src/adapters.js';
import { ChainDisabledError } from '../../src/chain/chainClient.js';
import { NoopChainClient } from '../../src/chain/noopChainClient.js';
import { SorobanChainClient } from '../../src/chain/sorobanChainClient.js';
import { createLogger } from '../../src/logger.js';
import { loadConfig } from '../../src/config/index.js';
import { SmsTwoWayConfirmation } from '../../src/confirmation/smsTwoWayConfirmation.js';
import { TabletConfirmation } from '../../src/confirmation/tabletConfirmation.js';
import type { Queryable } from '../../src/db/pool.js';
import {
  addDays,
  businessDate,
  daysBetween,
  daysInMonth,
  isIsoDate,
} from '../../src/domain/dates.js';
import { gradeCode } from '../../src/domain/grading.js';
import {
  depositRecordedSms,
  dispatchRecordedSms,
  feeStatementSms,
} from '../../src/domain/smsTemplates.js';
import { assertPledgeable, intakeWeightSource } from '../../src/domain/weightPolicy.js';
import { LocalDevKeyService } from '../../src/keys/localDevKeyService.js';
import { platformFeeModel } from '../../src/platformFees/platformFeeModel.js';
import { validEnv } from '../helpers/env.js';

const config = (overrides: Record<string, string> = {}) =>
  loadConfig({ ...validEnv(), ...overrides });

/** Records queries instead of running them. */
function recordingDb(): Queryable & { queries: { text: string; values: unknown[] }[] } {
  const queries: { text: string; values: unknown[] }[] = [];
  return {
    queries,
    query: ((text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }) as unknown as Queryable['query'],
  };
}

describe('dates', () => {
  it('turns an instant into the business date of the zone', () => {
    // 23:30 UTC is already the next day in Lagos (UTC+1).
    expect(businessDate(new Date('2026-09-30T23:30:00Z'), 'Africa/Lagos')).toBe('2026-10-01');
    expect(businessDate(new Date('2026-09-30T23:30:00Z'), 'UTC')).toBe('2026-09-30');
  });

  it('does day arithmetic across months and leap years', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-01-25', '2026-02-05')).toBe(11);
    expect(daysInMonth('2028-02-10')).toBe(29);
  });

  it.each(['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1'])('rejects %s', (value) => {
    expect(isIsoDate(value)).toBe(false);
  });
});

describe('grading (provision h)', () => {
  it('accepts codes and whole numbers, and returns the code', () => {
    expect(gradeCode(1)).toBe('1');
    expect(gradeCode(' G2 ')).toBe('G2');
    expect(gradeCode(1.5)).toBeNull();
    expect(gradeCode('  ')).toBeNull();
  });
});

describe('weight policy (provision f)', () => {
  it('maps WEIGHT_MODE to the intake weight source', () => {
    expect(intakeWeightSource('bag_estimate')).toBe('bag_estimate');
    expect(intakeWeightSource('scale_required')).toBe('scale');
  });

  it('allows pledging only fully weighed scale stock', () => {
    expect(assertPledgeable({ weightSource: 'scale', bagCount: 10, bagsWeighed: 10 }).ok).toBe(
      true,
    );
    expect(assertPledgeable({ weightSource: 'scale', bagCount: 10, bagsWeighed: 9 }).ok).toBe(
      false,
    );
    expect(
      assertPledgeable({ weightSource: 'bag_estimate', bagCount: 10, bagsWeighed: 10 }).ok,
    ).toBe(false);
  });
});

describe('platform fee models (provision g)', () => {
  const activity = { bagsIn: 120 };

  it('charges nothing under none and a rate per bag under per_bag', () => {
    expect(
      platformFeeModel('none').compute({ model: 'none', perBagRateNgn: null }, activity),
    ).toEqual({
      amountNgn: 0,
      implemented: true,
    });
    expect(
      platformFeeModel('per_bag').compute({ model: 'per_bag', perBagRateNgn: 12.5 }, activity),
    ).toEqual({ amountNgn: 1500, implemented: true });
  });

  it.each(['revenue_share', 'subscription'] as const)('marks %s as not built', (model) => {
    expect(platformFeeModel(model).compute({ model, perBagRateNgn: null }, activity)).toEqual({
      amountNgn: null,
      implemented: false,
    });
  });
});

describe('SMS templates', () => {
  it('writes plain English messages', () => {
    expect(
      depositRecordedSms({
        warehouseName: 'Dawanau',
        bags: 20,
        commodity: 'MAIZE_WHITE',
        grade: '1',
      }),
    ).toBe('Farmledge: Dawanau received 20 bags of white maize grade 1 from you.');
    expect(
      dispatchRecordedSms({
        warehouseName: 'Dawanau',
        bags: 5,
        commodity: 'MAIZE_YELLOW',
        grade: '2',
        deliveryNoteNo: 'KN-DN-000001',
        bagsRemaining: 15,
      }),
    ).toContain('You have 15 bags free there.');
    expect(
      feeStatementSms({
        warehouseName: 'Dawanau',
        outstandingNgn: 1234.5,
        accruedThrough: '2026-09-30',
      }),
    ).toBe('Farmledge: your storage fees at Dawanau as of 2026-09-30: NGN 1,234.50 outstanding.');
  });
});

describe('adapter selection', () => {
  it('touches no chain when CHAIN_ENABLED=false: every chain call fails loudly (provision b)', async () => {
    const keys = createKeyService(config(), recordingDb() as never);
    const chain = createChainClient(config(), keys, createLogger('silent'));
    expect(chain).toBeInstanceOf(NoopChainClient);
    expect(chain.enabled).toBe(false);
    await expect(chain.latestLedger()).rejects.toBeInstanceOf(ChainDisabledError);
    await expect(chain.anchor(recordingDb(), {} as never)).rejects.toBeInstanceOf(
      ChainDisabledError,
    );
  });

  it('talks to the configured receipt contract with CHAIN_ENABLED=true', () => {
    const keys = createKeyService(config(), recordingDb() as never);
    const chain = createChainClient(
      config({ CHAIN_ENABLED: 'true' }),
      keys,
      createLogger('silent'),
    );
    expect(chain).toBeInstanceOf(SorobanChainClient);
    expect(chain.contractId).toBe('CBW6TA5UJMXJY2VYPJV6WUVWNUP3PKZNPXFMC2CNVCWZDF3SKIT4UAIN');
  });

  it('refuses to start with KEY_SERVICE=kms (provision c)', () => {
    expect(() => createKeyService(config({ KEY_SERVICE: 'kms' }), recordingDb() as never)).toThrow(
      AdapterUnavailableError,
    );
  });

  it('picks the confirmation mode (provision e)', () => {
    expect(createConfirmation(config())).toBeInstanceOf(TabletConfirmation);
    expect(createConfirmation(config({ CONFIRMATION_MODE: 'sms_two_way' }))).toBeInstanceOf(
      SmsTwoWayConfirmation,
    );
  });
});

describe('LocalDevKeyService (provision c)', () => {
  const secret = 'a-test-secret-that-is-long-enough-123456';

  it('derives stable, distinct keys per subject and environment', async () => {
    const db = recordingDb();
    const test = new LocalDevKeyService(secret, 'test', db);
    const again = new LocalDevKeyService(secret, 'test', db);
    const live = new LocalDevKeyService(secret, 'live', db);
    const key = await test.publicKey('custodian:1');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await again.publicKey('custodian:1')).toBe(key);
    expect(await test.publicKey('custodian:2')).not.toBe(key);
    expect(await live.publicKey('custodian:1')).not.toBe(key);
  });

  it('signs with Ed25519 and logs every signature', async () => {
    const db = recordingDb();
    const keys = new LocalDevKeyService(secret, 'test', db);
    const payload = Buffer.from('receipt 42');
    const signature = await keys.sign('verifier:7', payload, {
      purpose: 'mint_cosign',
      deviceId: 'tab-1',
    });

    const publicKey = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(await keys.publicKey('verifier:7'), 'hex').toString('base64url'),
      },
      format: 'jwk',
    });
    expect(verify(null, payload, publicKey, Buffer.from(signature, 'hex'))).toBe(true);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.text).toContain('INSERT INTO key_signature_log');
    expect(db.queries[0]?.values).toEqual([
      'verifier:7',
      await keys.publicKey('verifier:7'),
      'mint_cosign',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      'tab-1',
    ]);
  });
});
