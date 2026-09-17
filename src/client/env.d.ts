/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute URL of the game server, e.g. "https://node-rts.onrender.com".
   * Leave unset when the server also serves the client (same origin).
   */
  readonly VITE_SERVER_URL?: string;
  /** Which transport the menu starts on: "server" (default) or "p2p". */
  readonly VITE_DEFAULT_MODE?: string;
  /** Set to "1" to hide the server option entirely (static-only deploys). */
  readonly VITE_P2P_ONLY?: string;
  /** Custom PeerJS broker. Unset uses the free public one. */
  readonly VITE_PEER_HOST?: string;
  readonly VITE_PEER_PORT?: string;
  readonly VITE_PEER_PATH?: string;
  readonly VITE_PEER_SECURE?: string;
  /** JSON array of RTCIceServer entries, for adding a TURN server. */
  readonly VITE_ICE_SERVERS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
