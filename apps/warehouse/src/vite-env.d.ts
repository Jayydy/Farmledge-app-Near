/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Where the API is mounted on this origin; `/api` by default. */
  readonly VITE_API_BASE?: string;
}
