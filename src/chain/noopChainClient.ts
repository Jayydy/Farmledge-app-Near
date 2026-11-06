import { ChainDisabledError, type ChainClient } from './chainClient.js';

/**
 * CHAIN_ENABLED=false, for tests and local development. Nothing touches a
 * network. Every chain call fails loudly with ChainDisabledError, so the
 * anchoring job still builds and stores each day's book but never claims
 * an anchor, and pledges are refused rather than half-done.
 */
export class NoopChainClient implements ChainClient {
  readonly enabled = false;
  readonly contractId = '';
  readonly networkPassphrase = '';
  readonly rpcUrl = '';

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
