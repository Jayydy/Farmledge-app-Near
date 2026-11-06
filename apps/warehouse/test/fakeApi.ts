import { HttpError, NetworkError, type ApiClient, type RequestOptions } from '../src/api/client';
import type {
  BatchItemResult,
  DepositRequest,
  DepositView,
  DispatchBlockedRequest,
  RegisterFarmerRequest,
  ScaleSampleRequest,
} from '../src/types/api';

export interface LoggedRequest {
  method: string;
  path: string;
  token: string | undefined;
  json: unknown;
}

type Fault =
  | { kind: 'offline' }
  /** The server does the work, then the answer never arrives. */
  | { kind: 'lost_response' }
  | { kind: 'status'; status: number; code: string };

/**
 * An in-memory stand-in for the API with the same idempotency rules:
 * deposits on deposit_id, samples on sample_id, photos on (deposit, bytes),
 * farmers on phone (409 farmer_already_registered with the existing id),
 * blocked-dispatch records on their id.
 */
export class FakeApi {
  readonly log: LoggedRequest[] = [];
  readonly deposits = new Map<string, DepositRequest & { deposit_no: number }>();
  readonly farmers = new Map<string, { id: string; request: RegisterFarmerRequest }>();
  readonly samples = new Map<string, ScaleSampleRequest & { deposit_id: string }>();
  readonly photos = new Map<string, Set<string>>();
  readonly blocked = new Map<string, DispatchBlockedRequest & { warehouse_id: string }>();
  readonly validTokens = new Set<string>(['token-a']);
  offline = false;
  private readonly faults: { match: (path: string) => boolean; fault: Fault }[] = [];
  /** Deposit ids the server rejects (e.g. moisture out of range). */
  readonly rejectDeposits = new Set<string>();
  private nextDepositNo = 1;
  private nextFarmer = 1;

  /** Fails the next request whose path matches. */
  failNext(match: string | RegExp, fault: Fault): void {
    this.faults.push({
      match: (path) => (typeof match === 'string' ? path.startsWith(match) : match.test(path)),
      fault,
    });
  }

  readonly client: ApiClient = (async (
    method: string,
    path: string,
    options: RequestOptions = {},
  ) => {
    this.log.push({ method, path, token: options.token, json: options.json });
    if (this.offline) throw new NetworkError('offline');
    const faultAt = this.faults.findIndex((f) => f.match(path));
    const fault = faultAt === -1 ? undefined : this.faults.splice(faultAt, 1)[0]?.fault;
    if (fault?.kind === 'offline') throw new NetworkError('offline');
    if (fault?.kind === 'status') {
      throw new HttpError(fault.status, { error: { code: fault.code, message: fault.code } });
    }
    if (options.token === undefined || !this.validTokens.has(options.token)) {
      throw new HttpError(401, {
        error: { code: 'session_invalid', message: 'Session has ended' },
      });
    }
    const response = await this.handle(method, path, options);
    if (fault?.kind === 'lost_response') throw new NetworkError('connection reset');
    return response;
  }) as ApiClient;

  private async handle(method: string, path: string, options: RequestOptions) {
    if (method === 'POST' && path === '/farmers') {
      const request = options.json as RegisterFarmerRequest;
      const existing = this.farmers.get(request.phone);
      if (existing !== undefined) {
        throw new HttpError(409, {
          error: {
            code: 'farmer_already_registered',
            message: 'already registered',
            details: { farmer_id: existing.id },
          },
        });
      }
      const id = `00000000-0000-4000-8000-${String(this.nextFarmer++).padStart(12, '0')}`;
      this.farmers.set(request.phone, { id, request });
      return { status: 201, data: { farmer: { id }, farmer_created: true } };
    }
    if (method === 'POST' && path === '/deposits/batch') {
      const { items } = options.json as { items: DepositRequest[] };
      const results: BatchItemResult[] = items.map((item, index) => {
        if (this.rejectDeposits.has(item.deposit_id)) {
          return {
            index,
            deposit_id: item.deposit_id,
            status: 'rejected',
            error: { code: 'validation_failed', message: 'Deposit is invalid', details: [] },
          };
        }
        const stored = this.deposits.get(item.deposit_id);
        if (stored !== undefined) {
          return { index, deposit_id: item.deposit_id, status: 'duplicate', deposit: view(stored) };
        }
        const created = { ...item, deposit_no: this.nextDepositNo++ };
        this.deposits.set(item.deposit_id, created);
        return { index, deposit_id: item.deposit_id, status: 'created', deposit: view(created) };
      });
      return { status: 200, data: { summary: {}, results } };
    }
    const sample = /^\/deposits\/([^/]+)\/scale-samples$/.exec(path);
    if (method === 'POST' && sample?.[1] !== undefined) {
      this.requireDeposit(sample[1]);
      const request = options.json as ScaleSampleRequest;
      const duplicate = this.samples.has(request.sample_id);
      if (!duplicate) this.samples.set(request.sample_id, { ...request, deposit_id: sample[1] });
      return { status: duplicate ? 200 : 201, data: { duplicate } };
    }
    const photo = /^\/deposits\/([^/]+)\/photos\?/.exec(path);
    if (method === 'POST' && photo?.[1] !== undefined && options.body !== undefined) {
      this.requireDeposit(photo[1]);
      const bytes = new Uint8Array(await options.body.arrayBuffer()).join(',');
      const set = this.photos.get(photo[1]) ?? new Set<string>();
      const duplicate = set.has(bytes);
      set.add(bytes);
      this.photos.set(photo[1], set);
      return { status: duplicate ? 200 : 201, data: { duplicate } };
    }
    const blocked = /^\/warehouses\/([^/]+)\/dispatch-blocked$/.exec(path);
    if (method === 'POST' && blocked?.[1] !== undefined) {
      const request = options.json as DispatchBlockedRequest;
      const duplicate = this.blocked.has(request.id);
      if (!duplicate) this.blocked.set(request.id, { ...request, warehouse_id: blocked[1] });
      return { status: duplicate ? 200 : 201, data: { duplicate } };
    }
    const slip = /^\/deposits\/([^/]+)\/slip$/.exec(path);
    if (method === 'GET' && slip?.[1] !== undefined) {
      const stored = this.requireDeposit(slip[1]);
      return {
        status: 200,
        data: {
          deposit: view(stored),
          proofs: [
            {
              leaf: { index: null },
              qr_payload: `{"deposit_no":${stored.deposit_no}}`,
              anchored: false,
            },
          ],
        },
      };
    }
    throw new HttpError(404, {
      error: { code: 'not_found', message: `No route for ${method} ${path}` },
    });
  }

  private requireDeposit(id: string) {
    const stored = this.deposits.get(id);
    if (stored === undefined) {
      throw new HttpError(404, { error: { code: 'not_found', message: 'Deposit not found' } });
    }
    return stored;
  }

  requestsTo(prefix: string): LoggedRequest[] {
    return this.log.filter((r) => r.path.startsWith(prefix));
  }
}

function view(stored: DepositRequest & { deposit_no: number }): DepositView {
  return {
    ...stored,
    grading_scheme: 'provisional',
    bag_count_confirmed: false,
    bag_size_kg: 100,
    weight_kg: stored.bag_count * 100,
    weight_source: 'bag_estimate',
    status: 'recorded',
    notes: null,
    created_at: stored.captured_at,
    needs_review: false,
    review_reasons: [],
    photo_count: 0,
    scale_samples: { count: 0, bags_weighed: 0, total_kg: null },
  };
}
