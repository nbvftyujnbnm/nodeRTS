/**
 * The reconnect token, kept out of the transport modules so that resuming a
 * session at boot does not drag socket.io or peerjs into the initial bundle.
 */
const STORAGE_KEY = 'nodeRTS.session';

export interface StoredSession {
  roomCode: string;
  token: string;
  /** Which transport the session belongs to, so a reload resumes the right one. */
  mode: 'server' | 'p2p';
}

export function loadStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (typeof parsed?.roomCode === 'string' && typeof parsed?.token === 'string') {
      return { ...parsed, mode: parsed.mode === 'p2p' ? 'p2p' : 'server' };
    }
  } catch {
    /* storage can be unavailable; the game still works without reconnect */
  }
  return null;
}

export function storeSession(session: StoredSession | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
