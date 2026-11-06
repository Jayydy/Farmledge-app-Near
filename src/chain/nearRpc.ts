export interface NearStatusResponse {
  readonly sync_info: {
    readonly latest_block_hash: string;
    readonly latest_block_height: number;
    readonly latest_block_time: string;
    readonly earliest_block_height?: number | null;
    readonly earliest_block_time?: string | null;
  };
}

export interface NearBlockResponse {
  readonly header: {
    readonly height: number;
    readonly hash: string;
    readonly timestamp: number;
    readonly timestamp_nanosec?: string;
  };
  readonly chunks?: readonly {
    readonly chunk_hash: string;
  }[];
}

export interface NearAccountView {
  readonly amount: string;
  readonly locked: string;
  readonly code_hash: string;
  readonly storage_usage: number;
  readonly block_height: number;
  readonly block_hash: string;
}

export interface NearAccessKeyView {
  readonly nonce: number | bigint;
  readonly permission: unknown;
  readonly block_height: number;
  readonly block_hash: string;
}

export interface NearFunctionCallActionView {
  readonly FunctionCall: {
    readonly method_name: string;
    readonly args: string; // base64
    readonly gas: number;
    readonly deposit: string;
  };
}

export interface NearOutcomeView {
  readonly id: string;
  readonly block_hash?: string;
  readonly outcome: {
    readonly executor_id: string;
    readonly logs: string[];
    readonly receipt_ids: string[];
    readonly status: {
      readonly SuccessValue?: string;
      readonly SuccessReceiptId?: string;
      readonly Failure?: unknown;
    };
  };
}

export interface NearTxStatusResponse {
  readonly status: {
    readonly SuccessValue?: string;
    readonly Failure?: unknown;
  };
  readonly transaction: {
    readonly hash: string;
    readonly signer_id: string;
    readonly public_key: string;
    readonly nonce: number;
    readonly receiver_id: string;
    readonly actions: readonly (NearFunctionCallActionView | Record<string, unknown>)[];
  };
  readonly transaction_outcome: NearOutcomeView;
  readonly receipts_outcome: readonly NearOutcomeView[];
}

/** Injectable RPC interface so `NearChainClient` and `nearEvents` can be unit-tested offline. */
export interface NearRpc {
  status(): Promise<NearStatusResponse>;
  block(ref: { blockId: number | string } | { finality: 'final' | 'optimistic' }): Promise<NearBlockResponse>;
  viewAccount(accountId: string): Promise<NearAccountView | null>;
  viewAccessKey(accountId: string, publicKey: string): Promise<NearAccessKeyView>;
  callFunction<T = unknown>(
    contractId: string,
    methodName: string,
    args: Record<string, unknown>,
  ): Promise<T>;
  sendTxAsync(signedTxBase64: string): Promise<string>;
  txStatus(txHash: string, senderAccountId: string): Promise<NearTxStatusResponse | null>;
}

/** Parses `E<code>:<Name>` or `Error(Contract, #<code>)` from a NEAR execution error string. */
export function parseNearContractError(text: string): number | null {
  const nearMatch = /\bE(\d+):[A-Za-z0-9_]+/.exec(text);
  if (nearMatch !== null) return Number(nearMatch[1]);
  const sorobanMatch = /Error\(Contract, #(\d+)\)/.exec(text);
  if (sorobanMatch !== null) return Number(sorobanMatch[1]);
  return null;
}

export class NearRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'NearRpcError';
  }
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
    cause?: { name?: string; info?: Record<string, unknown> };
  };
}

export class HttpNearRpc implements NearRpc {
  private nextId = 1;

  constructor(
    private readonly rpcUrl: string,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const id = String(this.nextId++);
    const res = await this.fetchFn(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!res.ok) {
      throw new NearRpcError(method, res.status, `HTTP ${res.status} from NEAR RPC (${method})`);
    }
    const body = (await res.json()) as JsonRpcResponse<T>;
    if (body.error !== undefined) {
      const detail =
        typeof body.error.data === 'string'
          ? body.error.data
          : JSON.stringify(body.error.data ?? body.error.cause ?? body.error.message);
      throw new NearRpcError(
        method,
        parseNearContractError(detail),
        `${body.error.message}: ${detail}`,
        body.error,
      );
    }
    if (body.result === undefined) {
      throw new NearRpcError(method, null, `NEAR RPC (${method}) returned neither result nor error`);
    }
    return body.result;
  }

  status(): Promise<NearStatusResponse> {
    return this.rpc<NearStatusResponse>('status', []);
  }

  block(
    ref: { blockId: number | string } | { finality: 'final' | 'optimistic' },
  ): Promise<NearBlockResponse> {
    const params = 'blockId' in ref ? { block_id: ref.blockId } : { finality: ref.finality };
    return this.rpc<NearBlockResponse>('block', params);
  }

  async viewAccount(accountId: string): Promise<NearAccountView | null> {
    try {
      return await this.rpc<NearAccountView>('query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      });
    } catch (err) {
      if (err instanceof NearRpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(err.message)) {
        return null;
      }
      throw err;
    }
  }

  viewAccessKey(accountId: string, publicKey: string): Promise<NearAccessKeyView> {
    return this.rpc<NearAccessKeyView>('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: accountId,
      public_key: publicKey,
    });
  }

  async callFunction<T = unknown>(
    contractId: string,
    methodName: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const argsBase64 = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
    const result = await this.rpc<{ result?: number[]; error?: string; block_height: number }>(
      'query',
      {
        request_type: 'call_function',
        finality: 'final',
        account_id: contractId,
        method_name: methodName,
        args_base64: argsBase64,
      },
    );
    if (typeof result.error === 'string' && result.error.length > 0) {
      throw new NearRpcError(
        methodName,
        parseNearContractError(result.error),
        result.error,
        result,
      );
    }
    const bytes = Buffer.from(result.result ?? []);
    if (bytes.length === 0) return null as T;
    return JSON.parse(bytes.toString('utf8')) as T;
  }

  sendTxAsync(signedTxBase64: string): Promise<string> {
    return this.rpc<string>('broadcast_tx_async', [signedTxBase64]);
  }

  async txStatus(txHash: string, senderAccountId: string): Promise<NearTxStatusResponse | null> {
    try {
      return await this.rpc<NearTxStatusResponse>('tx', {
        tx_hash: txHash,
        sender_account_id: senderAccountId,
        wait_until: 'NONE',
      });
    } catch (err) {
      if (
        err instanceof NearRpcError &&
        /UNKNOWN_TRANSACTION|TIMEOUT_ERROR|does not exist/i.test(err.message)
      ) {
        return null;
      }
      throw err;
    }
  }
}
