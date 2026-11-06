import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';

import { createApiClient } from './api/client';
import { openAppDb } from './db/schema';
import { ConnectivityMonitor } from './lib/connectivity';
import { SyncEngine } from './sync/engine';
import { App, type UpdateHandle } from './ui/App';
import './ui/styles.css';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

/** A new service worker waits; the app applies it only when no intake is open. */
let applyUpdate: () => void = () => undefined;
const updateListeners = new Set<() => void>();
let updateReady = false;
const updateSW = registerSW({
  onNeedRefresh() {
    updateReady = true;
    for (const listener of updateListeners) listener();
  },
});
applyUpdate = () => void updateSW(true);

function Root({ services }: { services: Parameters<typeof App>[0]['services'] }) {
  const [ready, setReady] = useState(updateReady);
  useEffect(() => {
    const listener = () => {
      setReady(true);
    };
    updateListeners.add(listener);
    return () => {
      updateListeners.delete(listener);
    };
  }, []);
  const update: UpdateHandle = { ready, apply: applyUpdate };
  return <App services={services} update={update} />;
}

async function start() {
  // Ask the browser not to evict the queue under storage pressure.
  void navigator.storage.persist().catch(() => false);
  const db = await openAppDb();
  const api = createApiClient(API_BASE);
  const changes = new EventTarget();
  const engine = new SyncEngine({
    db,
    api,
    onChange: () => changes.dispatchEvent(new Event('change')),
  });
  const connectivity = new ConnectivityMonitor(`${API_BASE}/health`);
  const root = document.getElementById('root');
  if (root === null) throw new Error('no #root');
  createRoot(root).render(
    <StrictMode>
      <Root services={{ db, api, engine, connectivity, changes }} />
    </StrictMode>,
  );
}

void start();
