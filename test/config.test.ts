import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config/index.js';
import { envSchema, NEAR_ENV_KEYS, STELLAR_ENV_KEYS } from '../src/config/schema.js';
import { validEnv } from './helpers/env.js';

function problemsFor(overrides: Record<string, string | undefined>): string[] {
  try {
    loadConfig({ ...validEnv(), ...overrides });
  } catch (err) {
    if (err instanceof ConfigError) return [...err.problems];
    throw err;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('builds typed config from a valid environment', () => {
    const config = loadConfig(validEnv());

    expect(config.environment).toBe('test');
    expect(config.server).toEqual({ port: 3000, shutdownTimeoutMs: 2000 });
    expect(config.commodities.MAIZE_WHITE).toEqual({
      bagSizeKg: 100,
      moistureBps: { min: 0, max: 1350 },
      shrinkageToleranceBps: 200,
    });
    expect(config.commodities.MAIZE_YELLOW.bagSizeKg).toBe(100);
    expect(config.grading).toEqual({ scheme: 'provisional', grades: ['1', '2', '3'] });
    expect(config.commodities.MAIZE_WHITE.shrinkageToleranceBps).toBe(200);
    expect(config.businessTimeZone).toBe('Africa/Lagos');
    expect(config.features).toEqual({
      lendingEnabled: false,
      chainEnabled: false,
      confirmationMode: 'tablet_only',
      weightMode: 'bag_estimate',
      releaseAuthority: 'paper',
    });
    expect(config.adapters).toMatchObject({
      keyService: 'local_dev',
      smsGateway: 'mock',
      pricingProvider: 'manual',
    });
    expect(config.intake).toEqual({
      bagCountMax: 1000,
      bagCountConfirmAbove: 300,
      offlineReviewAfterHours: 48,
      offlineRejectAfterHours: 168,
      cancelWindowHours: 24,
    });
    expect(config.photos).toEqual({ storageDir: './var/photos', maxBytes: 5_242_880 });
    expect(config.loan).toEqual({ gracePeriodDays: 14, recoverySaleWindowDays: 10 });
    expect(config.fees).toEqual({ intakePerBagNgn: 0, collateralMonthlyBps: 0, recoveryBps: 0 });
  });

  it('returns a frozen object', () => {
    const config = loadConfig(validEnv());
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.commodities.MAIZE_WHITE.moistureBps)).toBe(true);
  });

  it.each(
    Object.keys(validEnv()).filter(
      (key) => key !== 'CHAIN_BACKEND' && !(NEAR_ENV_KEYS as readonly string[]).includes(key),
    ),
  )('rejects a missing %s', (key) => {
    expect(problemsFor({ [key]: undefined })).toContain(`${key} is required`);
  });

  it.each(NEAR_ENV_KEYS)('rejects a missing %s when CHAIN_BACKEND=near', (key) => {
    expect(problemsFor({ CHAIN_BACKEND: 'near', [key]: undefined })).toContain(
      `${key} is required`,
    );
  });

  // Fixed-choice variables report a blank value as "must be one of …" instead.
  const CHOICES = [
    'FARMLEDGE_ENV',
    'LOG_LEVEL',
    'LENDING_ENABLED',
    'CHAIN_ENABLED',
    'CHAIN_BACKEND',
    'NEAR_NETWORK',
    'CONFIRMATION_MODE',
    'WEIGHT_MODE',
    'RELEASE_AUTHORITY',
    'KEY_SERVICE',
    'SMS_GATEWAY',
    'PRICING_PROVIDER',
    'AUTH_REQUIRED',
  ];

  it.each(Object.keys(validEnv()).filter((key) => !CHOICES.includes(key)))(
    'rejects a blank %s once',
    (key) => {
      expect(problemsFor({ [key]: '  ' })).toEqual([`${key} is required`]);
    },
  );

  it('lists every problem at once', () => {
    const problems = problemsFor({ FARMLEDGE_ENV: undefined, PORT: 'eighty' });
    expect(problems).toEqual(
      expect.arrayContaining(['FARMLEDGE_ENV is required', 'PORT must be a whole number']),
    );
  });

  it.each(['production', 'LIVE', 'dev'])('rejects FARMLEDGE_ENV=%s', (value) => {
    expect(problemsFor({ FARMLEDGE_ENV: value })).toEqual([
      'FARMLEDGE_ENV must be "test" or "live"',
    ]);
  });

  it.each(['mysql://u:p@localhost/db', 'not a url', 'postgresql://localhost', 'postgres:///db'])(
    'rejects DATABASE_URL=%s',
    (value) => {
      expect(problemsFor({ DATABASE_URL: value })).toEqual([
        'DATABASE_URL must be a postgres:// URL with a host and database name',
      ]);
    },
  );

  it.each(['0', '-100', '100kg', '1.5'])('rejects MAIZE_BAG_SIZE_KG=%s', (value) => {
    expect(problemsFor({ MAIZE_BAG_SIZE_KG: value })).toHaveLength(1);
  });

  it.each(['-1', '65536', '3000.5'])('rejects PORT=%s', (value) => {
    expect(problemsFor({ PORT: value })).toHaveLength(1);
  });

  it('rejects moisture limits above 100%', () => {
    expect(problemsFor({ MAIZE_MOISTURE_MAX_BPS: '10001' })).toEqual([
      'MAIZE_MOISTURE_MAX_BPS must be at most 10000',
    ]);
  });

  it('rejects a moisture minimum that is not below the maximum', () => {
    expect(problemsFor({ MAIZE_MOISTURE_MIN_BPS: '1400', MAIZE_MOISTURE_MAX_BPS: '1350' })).toEqual(
      ['MAIZE_MOISTURE_MAX_BPS must be greater than MAIZE_MOISTURE_MIN_BPS'],
    );
  });

  it.each(['1,x y', '1,,2', '1;2', 'G1,G2/3'])('rejects GRADE_VALUES=%s', (value) => {
    expect(problemsFor({ GRADE_VALUES: value })).toEqual([
      'GRADE_VALUES must be a comma-separated list of grade codes (letters, digits, . _ -), e.g. 1,2,3',
    ]);
  });

  it('accepts named grade codes, so a new standard needs no migration', () => {
    const config = loadConfig({
      ...validEnv(),
      GRADING_SCHEME: 'ng-maize-2026',
      GRADE_VALUES: 'G1,G2,G3',
    });
    expect(config.grading).toEqual({ scheme: 'ng-maize-2026', grades: ['G1', 'G2', 'G3'] });
  });

  it('rejects duplicate grades', () => {
    expect(problemsFor({ GRADE_VALUES: '1,2,2' })).toEqual([
      'GRADE_VALUES must not contain duplicates',
    ]);
  });

  it('trims grade codes and keeps the scheme order', () => {
    expect(loadConfig({ ...validEnv(), GRADE_VALUES: ' 3, 1 ,2' }).grading.grades).toEqual([
      '3',
      '1',
      '2',
    ]);
  });

  it.each([
    [
      { BUSINESS_TIMEZONE: 'Mars/Olympus' },
      'BUSINESS_TIMEZONE must be an IANA time zone, e.g. Africa/Lagos',
    ],
    [{ LENDING_ENABLED: 'yes' }, 'LENDING_ENABLED must be "true" or "false"'],
    [{ WEIGHT_MODE: 'scale' }, 'WEIGHT_MODE must be "bag_estimate" or "scale_required"'],
    [{ RELEASE_AUTHORITY: 'tablet' }, 'RELEASE_AUTHORITY must be "paper" or "farmledge"'],
    [
      { KEY_SERVICE_LOCAL_SECRET: 'short' },
      'KEY_SERVICE_LOCAL_SECRET must be at least 32 characters',
    ],
    [
      { GRADING_SCHEME: 'Has Spaces' },
      'GRADING_SCHEME must be lower-case letters, digits, . _ or -',
    ],
  ])('rejects %j', (overrides, problem) => {
    expect(problemsFor(overrides)).toEqual([problem]);
  });

  it('refuses the example key secret in live but allows it in test', () => {
    expect(problemsFor({ FARMLEDGE_ENV: 'live', AUTH_REQUIRED: 'true' })).toEqual([
      'KEY_SERVICE_LOCAL_SECRET must not be the example value in live',
    ]);
    expect(() =>
      loadConfig({
        ...validEnv(),
        FARMLEDGE_ENV: 'live',
        KEY_SERVICE_LOCAL_SECRET: 'x'.repeat(40),
        AUTH_REQUIRED: 'true',
      }),
    ).not.toThrow();
  });

  it('requires staff sign-in in live but not in test', () => {
    expect(
      problemsFor({
        FARMLEDGE_ENV: 'live',
        KEY_SERVICE_LOCAL_SECRET: 'x'.repeat(40),
        AUTH_REQUIRED: 'false',
      }),
    ).toEqual(['AUTH_REQUIRED must be true in live']);
    expect(loadConfig({ ...validEnv(), AUTH_REQUIRED: 'false' }).auth).toEqual({
      required: false,
      sessionTtlHours: 168,
    });
  });

  it('refuses paper release authority while lending is on, in any environment (D56)', () => {
    expect(problemsFor({ LENDING_ENABLED: 'true', RELEASE_AUTHORITY: 'paper' })).toEqual([
      'RELEASE_AUTHORITY must be farmledge while LENDING_ENABLED is true',
    ]);
    const config = (env: Record<string, string>) => loadConfig({ ...validEnv(), ...env }).features;
    expect(config({ LENDING_ENABLED: 'true', RELEASE_AUTHORITY: 'farmledge' })).toMatchObject({
      lendingEnabled: true,
      releaseAuthority: 'farmledge',
    });
    expect(config({ LENDING_ENABLED: 'false', RELEASE_AUTHORITY: 'paper' })).toMatchObject({
      lendingEnabled: false,
      releaseAuthority: 'paper',
    });
  });

  it('rejects negative fees and basis points above 100%', () => {
    expect(problemsFor({ FEE_INTAKE_PER_BAG_NGN: '-1', FEE_RECOVERY_BPS: '10001' }).sort()).toEqual(
      ['FEE_INTAKE_PER_BAG_NGN must be at least 0', 'FEE_RECOVERY_BPS must be at most 10000'],
    );
  });

  it.each([
    [
      { BAG_COUNT_CONFIRM_ABOVE: '1000' },
      'BAG_COUNT_CONFIRM_ABOVE must be less than BAG_COUNT_MAX',
    ],
    [
      { OFFLINE_REVIEW_AFTER_HOURS: '168' },
      'OFFLINE_REVIEW_AFTER_HOURS must be less than OFFLINE_REJECT_AFTER_HOURS',
    ],
  ])('rejects inverted intake thresholds %j', (overrides, problem) => {
    expect(problemsFor(overrides)).toEqual([problem]);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(problemsFor({ LOG_LEVEL: 'verbose' })).toHaveLength(1);
  });

  describe('CHAIN_BACKEND=near', () => {
    it('defaults CHAIN_BACKEND to stellar when omitted', () => {
      const config = loadConfig({ ...validEnv(), CHAIN_BACKEND: undefined });
      expect(config.chain.backend).toBe('stellar');
      expect(config.chain.contractId).toBe(
        'CBW6TA5UJMXJY2VYPJV6WUVWNUP3PKZNPXFMC2CNVCWZDF3SKIT4UAIN',
      );
    });

    it('builds NEAR chain config and skips STELLAR_* requirements when CHAIN_BACKEND=near', () => {
      const omitStellar = Object.fromEntries(STELLAR_ENV_KEYS.map((key) => [key, undefined]));
      const config = loadConfig({
        ...validEnv(),
        ...omitStellar,
        CHAIN_BACKEND: 'near',
      });
      expect(config.chain).toEqual({
        backend: 'near',
        rpcUrl: 'https://rpc.testnet.near.org',
        networkId: 'testnet',
        networkPassphrase: 'testnet',
        contractId: 'farmledge-receipt.team.testnet',
        startLedger: 0,
        indexerUrl: 'https://api.testnet.kitwallet.app',
        operatorFundYocto: 100_000_000_000_000_000_000_000n,
      });
    });

    it('skips NEAR_* requirements when CHAIN_BACKEND=stellar', () => {
      const omitNear = Object.fromEntries(NEAR_ENV_KEYS.map((key) => [key, undefined]));
      const config = loadConfig({
        ...validEnv(),
        ...omitNear,
        CHAIN_BACKEND: 'stellar',
      });
      expect(config.chain.backend).toBe('stellar');
    });

    it('rejects NEAR_NETWORK=mainnet when FARMLEDGE_ENV is not live', () => {
      expect(
        problemsFor({
          CHAIN_BACKEND: 'near',
          FARMLEDGE_ENV: 'test',
          NEAR_NETWORK: 'mainnet',
        }),
      ).toEqual(['NEAR_NETWORK must be testnet when FARMLEDGE_ENV is not live']);
    });

    it('rejects NEAR_NETWORK=testnet in live when CHAIN_ENABLED=true', () => {
      expect(
        problemsFor({
          CHAIN_BACKEND: 'near',
          FARMLEDGE_ENV: 'live',
          CHAIN_ENABLED: 'true',
          NEAR_NETWORK: 'testnet',
          KEY_SERVICE_LOCAL_SECRET: 'x'.repeat(40),
          AUTH_REQUIRED: 'true',
        }),
      ).toEqual(['NEAR_NETWORK must not be testnet in live']);
    });

    it('validates NEAR_CONTRACT_ID and NEAR_OPERATOR_FUND_YOCTO formats', () => {
      expect(
        problemsFor({
          CHAIN_BACKEND: 'near',
          NEAR_CONTRACT_ID: 'UPPERCASE.testnet',
        }),
      ).toEqual(['NEAR_CONTRACT_ID must be a valid NEAR account ID']);
      expect(
        problemsFor({
          CHAIN_BACKEND: 'near',
          NEAR_OPERATOR_FUND_YOCTO: '-100',
        }),
      ).toEqual(['NEAR_OPERATOR_FUND_YOCTO must be a non-negative integer in yoctoNEAR']);
    });
  });
});

describe('.env.example', () => {
  const example = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));

  it('passes validation', () => {
    expect(() => loadConfig(example)).not.toThrow();
  });

  it('lists exactly the variables the schema expects', () => {
    const schemaKeys = Object.keys(envSchema.shape).sort();
    expect(Object.keys(example).sort()).toEqual(schemaKeys);
    expect(Object.keys(validEnv()).sort()).toEqual(schemaKeys);
  });
});
