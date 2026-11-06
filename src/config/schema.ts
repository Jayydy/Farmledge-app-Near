import { z } from 'zod';

/**
 * Environment variable schema. Every variable for the active chain backend is
 * required: there are no silent guesses, so a missing or malformed value stops
 * the process at startup. `.env.example` lists them all.
 */

const required = (input: unknown) => (input === undefined ? 'is required' : 'must be a string');

const oneOf = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values, {
    error: (iss) =>
      iss.input === undefined
        ? 'is required'
        : `must be ${values.length === 2 ? values.map((v) => `"${v}"`).join(' or ') : `one of ${values.join(', ')}`}`,
  });

const text = () =>
  z
    .string({ error: (iss) => required(iss.input) })
    .trim()
    // abort: report a blank value once, not again as "must be a whole number" etc.
    .min(1, { error: 'is required', abort: true });

const integer = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  text()
    .regex(/^-?\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`));

const decimal = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  text()
    .regex(/^-?\d+(\.\d+)?$/, 'must be a number')
    .transform(Number)
    .pipe(z.number().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`));

const yoctoNear = text()
  .regex(/^\d+$/, 'must be a non-negative integer in yoctoNEAR')
  .transform((value) => BigInt(value));

const nearAccountId = text().regex(
  /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/,
  'must be a valid NEAR account ID',
);

const postgresUrl = text().refine((value) => {
  try {
    const { protocol, hostname, pathname } = new URL(value);
    return (
      (protocol === 'postgres:' || protocol === 'postgresql:') &&
      hostname !== '' &&
      pathname.length > 1
    );
  } catch {
    return false;
  }
}, 'must be a postgres:// URL with a host and database name');

const httpUrl = text().refine((value) => {
  try {
    const { protocol, hostname } = new URL(value);
    return (protocol === 'https:' || protocol === 'http:') && hostname !== '';
  } catch {
    return false;
  }
}, 'must be an http(s):// URL');

/** Grade codes of the configured grading scheme, in the scheme's order (best first). */
const gradeList = text()
  .transform((value) => value.split(',').map((part) => part.trim()))
  .refine((parts) => parts.every((part) => /^[A-Za-z0-9._-]{1,32}$/.test(part)), {
    message: 'must be a comma-separated list of grade codes (letters, digits, . _ -), e.g. 1,2,3',
  })
  .refine((grades) => new Set(grades).size === grades.length, {
    message: 'must not contain duplicates',
  });

const flag = () => oneOf(['true', 'false']).transform((value) => value === 'true');

const timeZone = text().refine((value) => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'must be an IANA time zone, e.g. Africa/Lagos');

/** The value in .env.example; refused in live so a real deployment sets its own. */
export const EXAMPLE_KEY_SECRET = 'local-dev-only-not-a-secret-change-me-0000';

export const STELLAR_ENV_KEYS = [
  'STELLAR_RPC_URL',
  'STELLAR_NETWORK_PASSPHRASE',
  'RECEIPT_CONTRACT_ID',
  'RECEIPT_CONTRACT_START_LEDGER',
] as const;

export const NEAR_ENV_KEYS = [
  'NEAR_NETWORK',
  'NEAR_RPC_URL',
  'NEAR_INDEXER_URL',
  'NEAR_CONTRACT_ID',
  'NEAR_CONTRACT_START_BLOCK',
  'NEAR_OPERATOR_FUND_YOCTO',
] as const;

export const envSchema = z
  .object({
    /** Which dataset this process may touch. Must match the database's own record. */
    FARMLEDGE_ENV: oneOf(['test', 'live']),
    DATABASE_URL: postgresUrl,

    /** 0 lets the OS pick a free port (used by tests). */
    PORT: integer(0, 65_535),
    LOG_LEVEL: oneOf(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    SHUTDOWN_TIMEOUT_MS: integer(1),

    // Commodities (design doc §10). Bag count is an intake convenience; kg is canonical.
    MAIZE_BAG_SIZE_KG: integer(1),
    // Basis points of a percent (1350 = 13.50%), matching the receipt contract.
    MAIZE_MOISTURE_MIN_BPS: integer(0, 10_000),
    MAIZE_MOISTURE_MAX_BPS: integer(0, 10_000),
    GRADE_VALUES: gradeList,

    // Deposit intake (docs/decisions.md).
    /** Bag counts above this are always rejected. */
    BAG_COUNT_MAX: integer(1, 100_000),
    /** Bag counts above this need `confirm_bag_count: true`, so typos are caught. */
    BAG_COUNT_CONFIRM_ABOVE: integer(1, 100_000),
    /** Offline captures older than this are accepted but flagged for review. */
    OFFLINE_REVIEW_AFTER_HOURS: integer(1, 24 * 365),
    /** Offline captures older than this are rejected. */
    OFFLINE_REJECT_AFTER_HOURS: integer(1, 24 * 365),
    /** Custodians may cancel a deposit this long after recording it; after that, only the owner. */
    DEPOSIT_CANCEL_WINDOW_HOURS: integer(0, 24 * 30),
    /** Root directory for the local-disk photo store; a subdirectory per environment is used. */
    PHOTO_STORAGE_DIR: text(),
    PHOTO_MAX_BYTES: integer(1_024, 50 * 1024 * 1024),

    // Grading (docs/decisions.md, provision h): a named scheme and its codes.
    GRADING_SCHEME: text().regex(
      /^[a-z0-9][a-z0-9._-]{0,63}$/,
      'must be lower-case letters, digits, . _ or -',
    ),
    /** Day boundaries for reports and storage-fee accrual. */
    BUSINESS_TIMEZONE: timeZone,
    /** Dispatches losing more than this share of book kg are flagged (100 bps = 1%). */
    MAIZE_SHRINKAGE_TOLERANCE_BPS: integer(0, 10_000),

    // Feature flags and adapter choices for open decisions (docs/decisions.md).
    LENDING_ENABLED: flag(),
    CHAIN_ENABLED: flag(),
    /** Which chain backend to use when CHAIN_ENABLED=true ('stellar' | 'near'). */
    CHAIN_BACKEND: oneOf(['stellar', 'near']).default('stellar'),
    CONFIRMATION_MODE: oneOf(['tablet_only', 'sms_two_way']),
    WEIGHT_MODE: oneOf(['bag_estimate', 'scale_required']),
    /** Whose record decides a release when Farmledge can't confirm a dispatch (D56). */
    RELEASE_AUTHORITY: oneOf(['paper', 'farmledge']),
    KEY_SERVICE: oneOf(['local_dev', 'kms']),
    /** Root secret the local-dev key service derives keys from. */
    KEY_SERVICE_LOCAL_SECRET: text().min(32, 'must be at least 32 characters'),
    SMS_GATEWAY: oneOf(['mock']),

    // Staff sign-in (docs/decisions.md D41).
    /** true: tablet intake routes need a staff session. Refused as false in live. */
    AUTH_REQUIRED: flag(),
    /** How long a sign-in stays valid on the server; covers the offline queue's age. */
    STAFF_SESSION_TTL_HOURS: integer(1, 24 * 30),
    PRICING_PROVIDER: oneOf(['manual']),

    // The receipt contract on Stellar, data_version 3 (protocol deployments/<network>.json).
    // Required when CHAIN_BACKEND=stellar; skipped when CHAIN_BACKEND=near.
    STELLAR_RPC_URL: httpUrl.optional(),
    STELLAR_NETWORK_PASSPHRASE: text().optional(),
    RECEIPT_CONTRACT_ID: text()
      .regex(/^C[A-Z2-7]{55}$/, 'must be a C… contract address')
      .optional(),
    /** The deployment's start_ledger: the indexer archives from here (docs/events.md). */
    RECEIPT_CONTRACT_START_LEDGER: integer(1).optional(),

    // The receipt contract on NEAR (Required when CHAIN_BACKEND=near; skipped when CHAIN_BACKEND=stellar).
    NEAR_NETWORK: oneOf(['testnet', 'mainnet']).optional(),
    NEAR_RPC_URL: httpUrl.optional(),
    NEAR_INDEXER_URL: httpUrl.optional(),
    NEAR_CONTRACT_ID: nearAccountId.optional(),
    NEAR_CONTRACT_START_BLOCK: integer(0).optional(),
    NEAR_OPERATOR_FUND_YOCTO: yoctoNear.optional(),

    /** Farmers' SMS links point here: the public bundle page, which checks proofs against the chain. */
    PROOF_LINK_BASE_URL: httpUrl,
    /** Where event-archive backups are written; mount off-site storage here. */
    ARCHIVE_BACKUP_DIR: text(),

    // Placeholders for open decisions (design doc §3.4, §5.5, §11.4). Not used yet.
    LOAN_GRACE_PERIOD_DAYS: integer(0),
    RECOVERY_SALE_WINDOW_DAYS: integer(1),
    FEE_INTAKE_PER_BAG_NGN: decimal(0),
    FEE_COLLATERAL_MONTHLY_BPS: integer(0, 10_000),
    FEE_RECOVERY_BPS: integer(0, 10_000),
  })
  .superRefine((env, ctx) => {
    if (env.MAIZE_MOISTURE_MIN_BPS >= env.MAIZE_MOISTURE_MAX_BPS) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIZE_MOISTURE_MAX_BPS'],
        message: 'must be greater than MAIZE_MOISTURE_MIN_BPS',
      });
    }
    if (env.BAG_COUNT_CONFIRM_ABOVE >= env.BAG_COUNT_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['BAG_COUNT_CONFIRM_ABOVE'],
        message: 'must be less than BAG_COUNT_MAX',
      });
    }
    if (env.FARMLEDGE_ENV === 'live' && env.KEY_SERVICE_LOCAL_SECRET === EXAMPLE_KEY_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['KEY_SERVICE_LOCAL_SECRET'],
        message: 'must not be the example value in live',
      });
    }
    // D56: lending is the observable sign that receipts carry real claims, and
    // then a release against an unconfirmed dispatch is a genuine exposure.
    if (env.LENDING_ENABLED && env.RELEASE_AUTHORITY === 'paper') {
      ctx.addIssue({
        code: 'custom',
        path: ['RELEASE_AUTHORITY'],
        message: 'must be farmledge while LENDING_ENABLED is true',
      });
    }
    if (env.FARMLEDGE_ENV === 'live' && !env.AUTH_REQUIRED) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_REQUIRED'],
        message: 'must be true in live',
      });
    }
    if (env.CHAIN_BACKEND === 'stellar') {
      for (const key of STELLAR_ENV_KEYS) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required',
          });
        }
      }
      if (
        env.FARMLEDGE_ENV === 'live' &&
        env.CHAIN_ENABLED &&
        env.STELLAR_NETWORK_PASSPHRASE !== undefined &&
        /Test SDF/.test(env.STELLAR_NETWORK_PASSPHRASE)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['STELLAR_NETWORK_PASSPHRASE'],
          message: 'must not be Testnet in live',
        });
      }
    } else {
      for (const key of NEAR_ENV_KEYS) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required',
          });
        }
      }
      // Non-production FARMLEDGE_ENV must use NEAR_NETWORK=testnet.
      if (env.FARMLEDGE_ENV !== 'live' && env.NEAR_NETWORK === 'mainnet') {
        ctx.addIssue({
          code: 'custom',
          path: ['NEAR_NETWORK'],
          message: 'must be testnet when FARMLEDGE_ENV is not live',
        });
      }
      // Mirror the "Test SDF" guard in live when chain is enabled.
      if (env.FARMLEDGE_ENV === 'live' && env.CHAIN_ENABLED && env.NEAR_NETWORK === 'testnet') {
        ctx.addIssue({
          code: 'custom',
          path: ['NEAR_NETWORK'],
          message: 'must not be testnet in live',
        });
      }
    }
    if (env.OFFLINE_REVIEW_AFTER_HOURS >= env.OFFLINE_REJECT_AFTER_HOURS) {
      ctx.addIssue({
        code: 'custom',
        path: ['OFFLINE_REVIEW_AFTER_HOURS'],
        message: 'must be less than OFFLINE_REJECT_AFTER_HOURS',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;
