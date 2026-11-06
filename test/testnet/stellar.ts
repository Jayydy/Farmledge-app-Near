import { hkdfSync, randomBytes } from 'node:crypto';

import {
  Account,
  Address,
  authorizeEntry,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

/** Testnet helpers for the integration suite only; never used by the app. */
export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const PASSPHRASE = 'Test SDF Network ; September 2015';
/** The audited v3 build, already uploaded to Testnet (README, Deployments). */
export const V3_WASM_HASH = '82070b2c14988393a675907bb49c98281cc8c8376f3bff4e54ccb7a00d2de40a';

export const server = new rpc.Server(RPC_URL);

export async function fund(address: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const status = await fetch(`https://friendbot.stellar.org/?addr=${address}`).then(
      (res) => res.status,
      () => 0,
    );
    // 400: already funded. Then wait until RPC sees the account.
    if (status === 200 || status === 400) {
      for (let i = 0; i < 20; i++) {
        if (
          await server.getAccount(address).then(
            () => true,
            () => false,
          )
        )
          return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (attempt >= 6) throw new Error(`friendbot ${address}: ${status}`);
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
}

/** The keypair LocalDevKeyService derives for a subject (same HKDF inputs), for test-side signing. */
export function localDevKeypair(secret: string, environment: string, subject: string): Keypair {
  const seed = Buffer.from(
    hkdfSync('sha256', secret, `farmledge:${environment}`, `ed25519:${subject}`, 32),
  );
  return Keypair.fromRawEd25519Seed(seed);
}

async function submit(
  tx: ReturnType<TransactionBuilder['build']>,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const sent = await server.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(`rejected: ${sent.errorResult?.result.type ?? ''}`);
  for (let i = 0; i < 60; i++) {
    const found = await server.getTransaction(sent.hash);
    if (found.status === rpc.Api.GetTransactionStatus.SUCCESS) return found;
    if (found.status === rpc.Api.GetTransactionStatus.FAILED)
      throw new Error(`failed: ${sent.hash}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out: ${sent.hash}`);
}

/** Deploys a throwaway instance of the v3 Wasm with `admin` as its admin. */
export async function deployInstance(
  admin: Keypair,
): Promise<{ contractId: string; ledger: number }> {
  const account = await server.getAccount(admin.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(
      Operation.createCustomContract({
        address: Address.fromString(admin.publicKey()),
        wasmHash: Buffer.from(V3_WASM_HASH, 'hex'),
        salt: randomBytes(32),
        constructorArgs: [Address.fromString(admin.publicKey()).toScVal()],
      }),
    )
    .setTimeout(300)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(admin);
  const done = await submit(prepared);
  if (done.returnValue === undefined) throw new Error('deploy returned nothing');
  return { contractId: Address.fromScVal(done.returnValue).toString(), ledger: done.ledger };
}

/**
 * Invokes a contract function from `source`, signing each address auth
 * entry with the matching keypair in `signers`.
 */
export async function invoke(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  source: Keypair,
  signers: Keypair[] = [],
): Promise<unknown> {
  const loaded = await server.getAccount(source.publicKey());
  // build() advances the sequence number, so each build starts from a copy.
  const build = (auth?: xdr.SorobanAuthorizationEntry[]) =>
    new TransactionBuilder(new Account(loaded.accountId(), loaded.sequenceNumber()), {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        auth === undefined
          ? new Contract(contractId).call(method, ...args)
          : Operation.invokeHostFunction({
              func: xdr.HostFunction.hostFunctionTypeInvokeContract(
                new xdr.InvokeContractArgs({
                  contractAddress: Address.fromString(contractId).toScAddress(),
                  functionName: method,
                  args,
                }),
              ),
              auth,
            }),
      )
      .setTimeout(300)
      .build();
  const sim = await server.simulateTransaction(build());
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`);
  const latest = await server.getLatestLedger();
  const auth: xdr.SorobanAuthorizationEntry[] = [];
  for (const entry of sim.result?.auth ?? []) {
    const credentials =
      entry.credentials.type === 'sorobanCredentialsAddress'
        ? entry.credentials.address
        : entry.credentials.type === 'sorobanCredentialsAddressV2'
          ? entry.credentials.addressV2
          : null;
    if (credentials === null) {
      auth.push(entry);
      continue;
    }
    const address = Address.fromScAddress(credentials.address).toString();
    const signer = signers.find((k) => k.publicKey() === address);
    if (signer === undefined) throw new Error(`${method} needs ${address}`);
    auth.push(await authorizeEntry(entry, signer, latest.sequence + 100, PASSPHRASE));
  }
  const prepared = await server.prepareTransaction(build(auth));
  prepared.sign(source);
  const done = await submit(prepared);
  return done.returnValue === undefined ? undefined : scValToNative(done.returnValue);
}
