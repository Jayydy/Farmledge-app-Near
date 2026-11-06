import { createContext, useContext } from 'react';

import type { ApiClient } from '../api/client';
import type { AppDb, OutboxItem, StoredSession } from '../db/schema';
import type { Features } from '../types/api';
import type { Connection, ConnectivityMonitor } from '../lib/connectivity';
import type { SyncEngine } from '../sync/engine';

export interface Services {
  db: AppDb;
  api: ApiClient;
  engine: SyncEngine;
  connectivity: ConnectivityMonitor;
}

/** What every screen can read and do. */
export interface AppState extends Services {
  connection: Connection;
  syncing: boolean;
  features: Features;
  session: StoredSession;
  /** Bumped whenever the outbox or local records change; screens re-read on it. */
  revision: number;
  syncNow: () => Promise<void>;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (value === null) throw new Error('useApp outside AppContext');
  return value;
}

export interface QueueSummary {
  /** Not yet sent (pending or sending), excluding those waiting for a sign-in. */
  waiting: number;
  failed: number;
  needsSignIn: number;
}

export function summarise(items: readonly OutboxItem[]): QueueSummary {
  const open = items.filter((item) => item.status !== 'done');
  const needsSignIn = open.filter(
    (item) => item.status === 'pending' && item.lastError?.kind === 'needs_sign_in',
  ).length;
  const failed = open.filter((item) => item.status === 'failed').length;
  return { waiting: open.length - failed - needsSignIn, failed, needsSignIn };
}
