import { loadConfig, type Config, type FarmledgeEnvironment } from '../../src/config/index.js';

/** A complete, valid environment. Tests override single values from here. */
export function validEnv(): Record<string, string> {
  return {
    FARMLEDGE_ENV: 'test',
    DATABASE_URL: 'postgresql://farmledge:farmledge@localhost:5433/farmledge',
    PORT: '3000',
    LOG_LEVEL: 'silent',
    SHUTDOWN_TIMEOUT_MS: '2000',
    MAIZE_BAG_SIZE_KG: '100',
    MAIZE_MOISTURE_MIN_BPS: '0',
    MAIZE_MOISTURE_MAX_BPS: '1350',
    GRADING_SCHEME: 'provisional',
    GRADE_VALUES: '1,2,3',
    MAIZE_SHRINKAGE_TOLERANCE_BPS: '200',
    BUSINESS_TIMEZONE: 'Africa/Lagos',
    LENDING_ENABLED: 'false',
    CHAIN_ENABLED: 'false',
    CHAIN_BACKEND: 'stellar',
    CONFIRMATION_MODE: 'tablet_only',
    WEIGHT_MODE: 'bag_estimate',
    RELEASE_AUTHORITY: 'paper',
    KEY_SERVICE: 'local_dev',
    KEY_SERVICE_LOCAL_SECRET: 'local-dev-only-not-a-secret-change-me-0000',
    SMS_GATEWAY: 'mock',
    AUTH_REQUIRED: 'false',
    STAFF_SESSION_TTL_HOURS: '168',
    PRICING_PROVIDER: 'manual',
    BAG_COUNT_MAX: '1000',
    BAG_COUNT_CONFIRM_ABOVE: '300',
    OFFLINE_REVIEW_AFTER_HOURS: '48',
    OFFLINE_REJECT_AFTER_HOURS: '168',
    DEPOSIT_CANCEL_WINDOW_HOURS: '24',
    PHOTO_STORAGE_DIR: './var/photos',
    PHOTO_MAX_BYTES: '5242880',
    LOAN_GRACE_PERIOD_DAYS: '14',
    RECOVERY_SALE_WINDOW_DAYS: '10',
    FEE_INTAKE_PER_BAG_NGN: '0',
    FEE_COLLATERAL_MONTHLY_BPS: '0',
    FEE_RECOVERY_BPS: '0',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    RECEIPT_CONTRACT_ID: 'CBW6TA5UJMXJY2VYPJV6WUVWNUP3PKZNPXFMC2CNVCWZDF3SKIT4UAIN',
    RECEIPT_CONTRACT_START_LEDGER: '4917586',
    NEAR_NETWORK: 'testnet',
    NEAR_RPC_URL: 'https://rpc.testnet.near.org',
    NEAR_INDEXER_URL: 'https://api.testnet.kitwallet.app',
    NEAR_CONTRACT_ID: 'farmledge-receipt.team.testnet',
    NEAR_CONTRACT_START_BLOCK: '0',
    NEAR_OPERATOR_FUND_YOCTO: '100000000000000000000000',
    PROOF_LINK_BASE_URL: 'https://proofs.example.test',
    ARCHIVE_BACKUP_DIR: './var/archive-backups',
  };
}

export function testConfig(
  databaseUrl: string,
  environment: FarmledgeEnvironment,
  overrides: Record<string, string> = {},
): Config {
  return loadConfig({
    ...validEnv(),
    FARMLEDGE_ENV: environment,
    DATABASE_URL: databaseUrl,
    PORT: '0',
    // Live config refuses the example secret.
    ...(environment === 'live'
      ? {
          KEY_SERVICE_LOCAL_SECRET: 'test-suite-live-secret-not-the-example-value',
          AUTH_REQUIRED: 'true',
        }
      : {}),
    ...overrides,
  });
}
