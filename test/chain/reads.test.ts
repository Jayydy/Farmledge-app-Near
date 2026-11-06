import type { rpc } from '@stellar/stellar-sdk';
import { Address, nativeToScVal, Networks, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { OPERATOR_SUBJECT } from '../../src/chain/addresses.js';
import { SorobanChainClient, type RpcServer } from '../../src/chain/sorobanChainClient.js';
import type { KeyService } from '../../src/keys/keyService.js';
import { createLogger } from '../../src/logger.js';

const CONTRACT = 'CBW6TA5UJMXJY2VYPJV6WUVWNUP3PKZNPXFMC2CNVCWZDF3SKIT4UAIN';

/** The contract instance entry, holding `storage` in its instance storage. */
function instanceEntry(storage: xdr.ScMapEntry[]): rpc.Api.GetLedgerEntriesResponse {
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: Address.fromString(CONTRACT).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
          storage,
        }),
      ),
    }),
  );
  return {
    latestLedger: 1,
    entries: [{ key: xdr.LedgerKey.contractData({} as never), val }],
  };
}

function client(response: rpc.Api.GetLedgerEntriesResponse): SorobanChainClient {
  const unused = () => Promise.reject(new Error('unexpected RPC call'));
  const server: RpcServer = {
    getLedgerEntries: () => Promise.resolve(response),
    getTransaction: unused,
    getLatestLedger: unused,
    sendTransaction: unused,
    simulateTransaction: unused,
    getAccount: unused,
    getEvents: unused,
  };
  return new SorobanChainClient(
    {
      rpcUrl: 'https://rpc.invalid',
      networkPassphrase: Networks.TESTNET,
      contractId: CONTRACT,
      operatorSubject: OPERATOR_SUBJECT,
    },
    {} as KeyService,
    createLogger('silent'),
    () => new Date(),
    server,
  );
}

describe('chain client reads (INV-9 completeness)', () => {
  it('reads the last assigned receipt id from DataKey::NextReceiptId in instance storage', async () => {
    const entry = (key: xdr.ScVal, val: xdr.ScVal) => new xdr.ScMapEntry({ key, val });
    const response = instanceEntry([
      entry(
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('NextSaleId')]),
        nativeToScVal(9n, { type: 'u64' }),
      ),
      entry(
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('NextReceiptId')]),
        nativeToScVal(42n, { type: 'u64' }),
      ),
    ]);
    expect(await client(response).lastReceiptId()).toBe(42n);
  });

  it('reads 0 when no receipt has been minted yet', async () => {
    expect(await client(instanceEntry([])).lastReceiptId()).toBe(0n);
  });

  it('refuses, rather than answering 0, when the instance cannot be read', async () => {
    const none = { latestLedger: 1, entries: [] } as unknown as rpc.Api.GetLedgerEntriesResponse;
    await expect(client(none).lastReceiptId()).rejects.toThrow(/instance .* not found/);
  });
});
