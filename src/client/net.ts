import { io, type Socket } from 'socket.io-client';
import { C2S, S2C } from '../shared/protocol';
import type { GameEvent, Snapshot } from '../shared/types';
import type {
  GameTransport,
  LobbyPayload,
  NetHandlers,
  RoomJoinedPayload,
  TransportMode,
} from './transport';

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

/**
 * Where the game server lives.
 *
 * Empty (the default) means "same origin", which is what happens when the Node
 * server serves the built client itself. Set VITE_SERVER_URL at build time to
 * host the client separately (GitHub Pages, Vercel, any static host) and point
 * it at a server running elsewhere.
 */
export const SERVER_URL = (import.meta.env.VITE_SERVER_URL ?? '').trim();

export class Net implements GameTransport {
  readonly mode: TransportMode = 'server';

  private readonly socket: Socket;

  constructor(private readonly handlers: NetHandlers) {
    const options = { transports: ['websocket', 'polling'] };
    this.socket = SERVER_URL ? io(SERVER_URL, options) : io(options);

    this.socket.on('connect', () => this.handlers.onConnectionChange(true));
    this.socket.on('disconnect', () => this.handlers.onConnectionChange(false));
    this.socket.on(S2C.roomJoined, (p: RoomJoinedPayload) => this.handlers.onRoomJoined(p));
    this.socket.on(S2C.lobby, (p: LobbyPayload) => this.handlers.onLobby(p));
    this.socket.on(S2C.snapshot, (p: Snapshot) => this.handlers.onSnapshot(p));
    this.socket.on(S2C.events, (p: { events: GameEvent[] }) => this.handlers.onEvents(p.events ?? []));
    this.socket.on(S2C.error, (p: { message: string }) => this.handlers.onError(p?.message ?? 'error'));
    this.socket.on(S2C.kicked, (p: { message: string }) => this.handlers.onKicked(p?.message ?? 'disconnected'));
  }

  createRoom(name: string): void {
    this.socket.emit(C2S.createRoom, { name });
  }

  joinRoom(code: string, name: string): void {
    this.socket.emit(C2S.joinRoom, { code, name });
  }

  tryReconnect(roomCode: string, token: string): void {
    this.socket.emit(C2S.reconnect, { roomCode, token });
  }

  startGame(): void {
    this.socket.emit(C2S.startGame, {});
  }

  buildLine(fromNodeId: string, targetX: number, targetY: number): void {
    this.socket.emit(C2S.buildLine, { fromNodeId, targetX, targetY });
  }

  leaveRoom(): void {
    this.socket.emit(C2S.leaveRoom, {});
  }

  dispose(): void {
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}
