/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute URL of the game server, e.g. "https://node-rts.onrender.com".
   * Leave unset when the server also serves the client (same origin).
   */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
