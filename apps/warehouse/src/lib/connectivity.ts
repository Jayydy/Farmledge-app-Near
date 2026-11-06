/**
 * Whether the API can actually be reached. `navigator.onLine` only knows
 * about the local link (a warehouse Wi-Fi with no uplink still says
 * "online"), so it is combined with a /health probe.
 */
export const PROBE_INTERVAL_MS = 20_000;

export type Connection = 'online' | 'offline';

export class ConnectivityMonitor {
  private state: Connection = navigator.onLine ? 'online' : 'offline';
  private readonly listeners = new Set<(state: Connection) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly healthUrl = '/api/health') {}

  get current(): Connection {
    return this.state;
  }

  start(): void {
    window.addEventListener('online', this.probeSoon);
    window.addEventListener('offline', this.goOffline);
    this.timer = setInterval(this.probeSoon, PROBE_INTERVAL_MS);
    this.probeSoon();
  }

  stop(): void {
    window.removeEventListener('online', this.probeSoon);
    window.removeEventListener('offline', this.goOffline);
    clearInterval(this.timer);
  }

  subscribe(listener: (state: Connection) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The sync engine reports a request with no answer. */
  reportUnreachable(): void {
    this.set('offline');
  }

  private readonly probeSoon = () => {
    void this.probe();
  };

  readonly probe = async (): Promise<void> => {
    if (!navigator.onLine) {
      this.set('offline');
      return;
    }
    try {
      const response = await fetch(this.healthUrl, {
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      });
      // Any answer from the API (even a 503 for its database) means the link works.
      this.set(response.status < 502 || response.status === 503 ? 'online' : 'offline');
    } catch {
      this.set('offline');
    }
  };

  private readonly goOffline = () => {
    this.set('offline');
  };

  private set(state: Connection): void {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
