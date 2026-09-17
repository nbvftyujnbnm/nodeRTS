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
  /**
   * The session is over. `fatal` means it cannot be resumed at all (in P2P the
   * host - and with them the whole game state - is gone), so the UI must return
   * to the menu rather than sit on a board that will never update again.
   */
  onKicked(message: string, fatal?: boolean): void;
  onConnectionChange(connected: boolean): void;
}

/** How this client reaches the authoritative simulation. */
export type TransportMode = 'server' | 'p2p';

/**
 * The UI talks to exactly this surface, so it does not care whether the
 * authority is a Node server over Socket.IO or another player's browser over
 * WebRTC.
 */
export interface GameTransport {
  readonly mode: TransportMode;
  createRoom(name: string): void;
  joinRoom(code: string, name: string): void;
  tryReconnect(roomCode: string, token: string): void;
  startGame(): void;
  buildLine(fromNodeId: string, targetX: number, targetY: number): void;
  leaveRoom(): void;
  dispose(): void;
}
