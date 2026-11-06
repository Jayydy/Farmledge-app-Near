import path from 'node:path';

/** Fixed values shared by the API launcher, the config and the specs (see scripts/seed-dev.sql). */
export const E2E = {
  apiPort: 3999,
  appPort: 4173,
  custodianPhone: '+2348000000001',
  pin: '482915',
  warehouseId: '6f1f2c3e-0000-4000-8000-000000000001',
  farmerPhone: '08031234567',
} as const;

/** Written by start-api.ts: where the throwaway database is. */
export const STATE_FILE = path.join(import.meta.dirname, '.state.json');
