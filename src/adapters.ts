import type pg from 'pg';

import type { ChainClient } from './chain/chainClient.js';
import { OPERATOR_SUBJECT } from './chain/addresses.js';
import { NoopChainClient } from './chain/noopChainClient.js';
import { SorobanChainClient } from './chain/sorobanChainClient.js';
import type { Config } from './config/index.js';
import type { FarmerConfirmation } from './confirmation/farmerConfirmation.js';
import { SmsTwoWayConfirmation } from './confirmation/smsTwoWayConfirmation.js';
import { TabletConfirmation } from './confirmation/tabletConfirmation.js';
import type { KeyService } from './keys/keyService.js';
import { LocalDevKeyService } from './keys/localDevKeyService.js';
import type { LendingService } from './lending/lendingService.js';
import { NotImplementedLendingService } from './lending/notImplementedLendingService.js';
import type { Logger } from './logger.js';
import { ManualPriceProvider } from './pricing/manualPriceProvider.js';
import type { PricingProvider } from './pricing/pricingProvider.js';
import { MockSmsGateway } from './sms/mockSmsGateway.js';
import type { SmsGateway } from './sms/smsGateway.js';

/**
 * The one place a port's implementation is chosen from config
 * (docs/architecture.md). Services receive ports and never read the flags
 * that pick them.
 */
export interface Adapters {
  chain: ChainClient;
  keys: KeyService;
  sms: SmsGateway;
  confirmation: FarmerConfirmation;
  lending: LendingService;
  pricing: PricingProvider;
}

export class AdapterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterUnavailableError';
  }
}

export function createChainClient(config: Config, keys: KeyService, logger: Logger): ChainClient {
  if (!config.features.chainEnabled) return new NoopChainClient();
  return new SorobanChainClient(
    {
      rpcUrl: config.chain.rpcUrl,
      networkPassphrase: config.chain.networkPassphrase,
      contractId: config.chain.contractId,
      operatorSubject: OPERATOR_SUBJECT,
    },
    keys,
    logger,
  );
}

export function createKeyService(config: Config, db: pg.Pool): KeyService {
  if (config.adapters.keyService === 'kms') {
    throw new AdapterUnavailableError(
      'KEY_SERVICE=kms but this build has no KMS adapter; set KEY_SERVICE=local_dev',
    );
  }
  return new LocalDevKeyService(config.adapters.keyServiceLocalSecret, config.environment, db);
}

export function createConfirmation(config: Config): FarmerConfirmation {
  return config.features.confirmationMode === 'sms_two_way'
    ? new SmsTwoWayConfirmation()
    : new TabletConfirmation();
}

export function createAdapters(config: Config, db: pg.Pool, logger: Logger): Adapters {
  const keys = createKeyService(config, db);
  return {
    chain: createChainClient(config, keys, logger),
    keys,
    sms: new MockSmsGateway(logger),
    confirmation: createConfirmation(config),
    lending: new NotImplementedLendingService(),
    pricing: new ManualPriceProvider(db),
  };
}
