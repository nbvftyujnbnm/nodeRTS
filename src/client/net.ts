import { io, type Socket } from 'socket.io-client';
import { C2S, S2C } from '../shared/protocol';
import type { GameEvent, PlayerPublic, RoomStatus, Snapshot } from '../shared/types';

export interface LobbyPayload {
  roomCode: string;
  hostId: string | null;
  status: RoomStatus;
  players: PlayerPublic[];
}

export interface RoomJoinedPayload {
  roomCode: string;
  playerId: string;
  reconnectToken: string;
  status: RoomStatus;
}

export interface NetHandlers {
  onRoomJoined(payload: RoomJoinedPayload): void;
  onLobby(payload: LobbyPayload): void;
  onSnapshot(snapshot: Snapshot): void;
  onEvents(events: GameEvent[]): void;
  onError(message: string): void;
  onKicked(message: string): void;
  onConnectionChange(connected: boolean): void;
}

const STORAGE_KEY = 'nodeRTS.session';

export interface StoredSession {
  roomCode: string;
  token: string;
}

export function loadStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (typeof parsed?.roomCode === 'string' && typeof parsed?.token === 'string') return parsed;
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

export class Net {
  private readonly socket: Socket;

  constructor(private readonly handlers: NetHandlers) {
    this.socket = io({ transports: ['websocket', 'polling'] });

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
}
