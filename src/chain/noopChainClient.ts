import { ChainDisabledError, type ChainBackend, type ChainClient } from './chainClient.js';

const STELLAR_G_RE = /^G[A-Z2-7]{55}$/;
const NEAR_ACCOUNT_RE = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;

/**
 * CHAIN_ENABLED=false, for tests and local development. Nothing touches a
 * network. Every chain call fails loudly with ChainDisabledError, so the
 * anchoring job still builds and stores each day's book but never claims
 * an anchor, and pledges are refused rather than half-done.
 */
export class NoopChainClient implements ChainClient {
  readonly backend: ChainBackend;
  readonly enabled = false;
  readonly contractId = '';
  readonly networkId = '';
  readonly networkPassphrase = '';
  readonly rpcUrl = '';
  readonly capabilities = { ttl: false } as const;

  constructor(backend: ChainBackend = 'stellar') {
    this.backend = backend;
  }

  validateAccount(address: string): boolean {
    return this.backend === 'near' ? NEAR_ACCOUNT_RE.test(address) : STELLAR_G_RE.test(address);
  }

  private disabled(): Promise<never> {
    return Promise.reject(new ChainDisabledError());
  }

  latestLedger = () => this.disabled();
  instanceExists = () => this.disabled();
  getAnchor = () => this.disabled();
  getReceipt = () => this.disabled();
  lastReceiptId = () => this.disabled();
  isClaimed = () => this.disabled();
  leafHash = () => this.disabled();
  receiptLiveUntil = () => this.disabled();
  getEvents = () => this.disabled();
  addressOf = () => this.disabled();
  anchor = () => this.disabled();
  mintFromAnchor = () => this.disabled();
  prepareLock = () => this.disabled();
  submitLock = () => this.disabled();
  extendTtlBatch = () => this.disabled();
  resolve = () => this.disabled();
}
