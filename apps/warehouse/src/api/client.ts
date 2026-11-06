import type { ApiErrorBody } from '../types/api';

/** No answer from the API: offline, DNS, timeout, connection reset. Always retried. */
export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

/** The API answered with a non-2xx status. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.error.message ?? `HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.code = body?.error.code ?? `http_${status}`;
    this.details = body?.error.details;
  }

  /** Worth retrying unchanged: the server or the path to it is struggling. */
  get transient(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

export interface RequestOptions {
  token?: string | undefined;
  json?: unknown;
  /** A raw body (photo bytes) with its content type. */
  body?: Blob;
  contentType?: string;
  timeoutMs?: number;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
}

export type ApiClient = <T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options?: RequestOptions,
) => Promise<ApiResponse<T>>;

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * A small fetch wrapper. `base` is where the API is mounted on this origin
 * (`/api`, proxied in dev and preview, reverse-proxied in production).
 */
export function createApiClient(
  base = '/api',
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): ApiClient {
  const client = async (method: string, path: string, options: RequestOptions = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.body !== undefined) {
      headers['Content-Type'] = options.contentType ?? options.body.type;
      body = options.body;
    }

    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body ?? null,
        cache: 'no-store',
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new NetworkError('The server could not be reached', { cause: err });
    }

    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        // A proxy's HTML error page, say; a 2xx with junk is treated as a server fault.
        if (response.ok) throw new HttpError(502, null);
      }
    }
    if (!response.ok) throw new HttpError(response.status, asErrorBody(parsed));
    return { status: response.status, data: parsed };
  };
  // The caller names the response type; the API's shape is trusted (src/types/api.ts).
  return client as ApiClient;
}

function asErrorBody(value: unknown): ApiErrorBody | null {
  if (typeof value !== 'object' || value === null || !('error' in value)) return null;
  const error = value.error;
  if (typeof error !== 'object' || error === null) return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string' ? (value as ApiErrorBody) : null;
}
