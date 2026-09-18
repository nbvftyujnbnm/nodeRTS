import { io, type Socket } from 'socket.io-client';
import { C2S, S2C } from '../shared/protocol';
import type { SnapshotMessage } from '../shared/delta';
import type { GameEvent } from '../shared/types';
import type {
  GameTransport,
  LobbyPayload,
  NetHandlers,
  RoomJoinedPayload,
  TransportMode,
} from './transport';

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
    this.socket.on(S2C.snapshot, (p: SnapshotMessage) => this.handlers.onSnapshot(p));
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
