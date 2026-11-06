import type { Features } from '../types/api';

/**
 * The API's .env.example values, used only until the first successful
 * GET /features (which needs the first online sign-in anyway). After that the
 * cached server values are used, so the tablet checks deposits offline with
 * the server's own rules (docs/decisions.md D42).
 */
export const DEFAULT_FEATURES: Features = {
  lending_enabled: false,
  chain_enabled: false,
  confirmation_mode: 'tablet_only',
  weight_mode: 'bag_estimate',
  release_authority: 'paper',
  grading: { scheme: 'provisional', grades: ['1', '2', '3'] },
  business_timezone: 'Africa/Lagos',
  auth_required: true,
  intake: {
    commodities: [
      { code: 'MAIZE_WHITE', bag_size_kg: 100, moisture_pct: { min: 0, max: 13.5 } },
      { code: 'MAIZE_YELLOW', bag_size_kg: 100, moisture_pct: { min: 0, max: 13.5 } },
    ],
    bag_count_max: 1000,
    bag_count_confirm_above: 300,
    offline_review_after_hours: 48,
    offline_reject_after_hours: 168,
    notes_max_length: 500,
    photos: {
      max_per_deposit: 3,
      max_bytes: 5 * 1024 * 1024,
      types: ['image/jpeg', 'image/png', 'image/webp'],
    },
  },
};
