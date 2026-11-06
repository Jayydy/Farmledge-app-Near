import { envSchema } from './schema.js';

/** Commodities accepted in Phase 1. Must match the `commodity` enum in the database. */
export const COMMODITIES = ['MAIZE_WHITE', 'MAIZE_YELLOW'] as const;
export type Commodity = (typeof COMMODITIES)[number];

export type FarmledgeEnvironment = 'test' | 'live';

export interface CommodityConfig {
  readonly bagSizeKg: number;
  /** Basis points of a percent (1350 = 13.50%). */
  readonly moistureBps: { readonly min: number; readonly max: number };
  /** Dispatch shrinkage above this share of book kg is flagged, in basis points. */
  readonly shrinkageToleranceBps: number;
}

export interface GradingConfig {
  /** Name of the grading scheme in force, stored with every grade. */
  readonly scheme: string;
  /** Its grade codes, best first. */
  readonly grades: readonly string[];
}

export type ConfirmationMode = 'tablet_only' | 'sms_two_way';
export type WeightMode = 'bag_estimate' | 'scale_required';
/**
 * D56. `paper`: the warehouse's own record is binding (the shadow trial);
 * Farmledge never tells anyone to hold grain. `farmledge`: an unconfirmed
 * dispatch means the bags stay.
 */
export type ReleaseAuthority = 'paper' | 'farmledge';

/** Switches for open decisions; each has a working default (docs/decisions.md). */
export interface FeatureConfig {
  readonly lendingEnabled: boolean;
  readonly chainEnabled: boolean;
  readonly confirmationMode: ConfirmationMode;
  readonly weightMode: WeightMode;
  readonly releaseAuthority: ReleaseAuthority;
}

/** Which implementation each port uses; chosen in `src/adapters.ts`. */
export interface AdapterConfig {
  readonly keyService: 'local_dev' | 'kms';
  readonly keyServiceLocalSecret: string;
  readonly smsGateway: 'mock';
  readonly pricingProvider: 'manual';
}

/** The receipt contract this deployment talks to (data_version 3). */
export interface ChainConfig {
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  readonly contractId: string;
  readonly startLedger: number;
}

export interface Config {
  readonly environment: FarmledgeEnvironment;
  readonly chain: ChainConfig;
  readonly proofs: { readonly linkBaseUrl: string };
  readonly archive: { readonly backupDir: string };
  readonly database: { readonly url: string };
  readonly server: { readonly port: number; readonly shutdownTimeoutMs: number };
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly commodities: Readonly<Record<Commodity, CommodityConfig>>;
  readonly grading: GradingConfig;
  /** IANA zone whose calendar days reports and fee accrual use. */
  readonly businessTimeZone: string;
  readonly features: FeatureConfig;
  readonly adapters: AdapterConfig;
  readonly intake: {
    readonly bagCountMax: number;
    readonly bagCountConfirmAbove: number;
    readonly offlineReviewAfterHours: number;
    readonly offlineRejectAfterHours: number;
    /** After this, only the warehouse owner may cancel a deposit. */
    readonly cancelWindowHours: number;
  };
  readonly photos: { readonly storageDir: string; readonly maxBytes: number };
  /** Staff sign-in (docs/decisions.md D41). */
  readonly auth: { readonly required: boolean; readonly sessionTtlHours: number };
  /** Placeholders for open decisions in the design doc; nothing reads these yet. */
  readonly loan: { readonly gracePeriodDays: number; readonly recoverySaleWindowDays: number };
  readonly fees: {
    readonly intakePerBagNgn: number;
    readonly collateralMonthlyBps: number;
    readonly recoveryBps: number;
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates the environment and builds the typed config. Throws a
 * {@link ConfigError} listing every problem at once, so a bad deploy can be
 * fixed in one pass.
 */
export function loadConfig(source: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`),
    );
  }
  const env = parsed.data;

  const maize: CommodityConfig = {
    bagSizeKg: env.MAIZE_BAG_SIZE_KG,
    moistureBps: { min: env.MAIZE_MOISTURE_MIN_BPS, max: env.MAIZE_MOISTURE_MAX_BPS },
    shrinkageToleranceBps: env.MAIZE_SHRINKAGE_TOLERANCE_BPS,
  };

  return deepFreeze({
    environment: env.FARMLEDGE_ENV,
    database: { url: env.DATABASE_URL },
    chain: {
      rpcUrl: env.STELLAR_RPC_URL,
      networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
      contractId: env.RECEIPT_CONTRACT_ID,
      startLedger: env.RECEIPT_CONTRACT_START_LEDGER,
    },
    proofs: { linkBaseUrl: env.PROOF_LINK_BASE_URL.replace(/\/+$/, '') },
    archive: { backupDir: env.ARCHIVE_BACKUP_DIR },
    server: { port: env.PORT, shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS },
    logLevel: env.LOG_LEVEL,
    commodities: { MAIZE_WHITE: maize, MAIZE_YELLOW: maize },
    grading: { scheme: env.GRADING_SCHEME, grades: env.GRADE_VALUES },
    businessTimeZone: env.BUSINESS_TIMEZONE,
    features: {
      lendingEnabled: env.LENDING_ENABLED,
      chainEnabled: env.CHAIN_ENABLED,
      confirmationMode: env.CONFIRMATION_MODE,
      weightMode: env.WEIGHT_MODE,
      releaseAuthority: env.RELEASE_AUTHORITY,
    },
    adapters: {
      keyService: env.KEY_SERVICE,
      keyServiceLocalSecret: env.KEY_SERVICE_LOCAL_SECRET,
      smsGateway: env.SMS_GATEWAY,
      pricingProvider: env.PRICING_PROVIDER,
    },
    intake: {
      bagCountMax: env.BAG_COUNT_MAX,
      bagCountConfirmAbove: env.BAG_COUNT_CONFIRM_ABOVE,
      offlineReviewAfterHours: env.OFFLINE_REVIEW_AFTER_HOURS,
      offlineRejectAfterHours: env.OFFLINE_REJECT_AFTER_HOURS,
      cancelWindowHours: env.DEPOSIT_CANCEL_WINDOW_HOURS,
    },
    photos: { storageDir: env.PHOTO_STORAGE_DIR, maxBytes: env.PHOTO_MAX_BYTES },
    auth: { required: env.AUTH_REQUIRED, sessionTtlHours: env.STAFF_SESSION_TTL_HOURS },
    loan: {
      gracePeriodDays: env.LOAN_GRACE_PERIOD_DAYS,
      recoverySaleWindowDays: env.RECOVERY_SALE_WINDOW_DAYS,
    },
    fees: {
      intakePerBagNgn: env.FEE_INTAKE_PER_BAG_NGN,
      collateralMonthlyBps: env.FEE_COLLATERAL_MONTHLY_BPS,
      recoveryBps: env.FEE_RECOVERY_BPS,
    },
  });
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null && !Object.isFrozen(child)) {
      deepFreeze(child as object);
    }
  }
  return Object.freeze(value);
}
