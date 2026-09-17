import type { GameEvent, PlayerPublic, RoomStatus, Snapshot } from './types';

/** Payloads sent by clients. Everything here is untrusted. */
export interface CreateRoomRequest {
  name: string;
}

export interface JoinRoomRequest {
  code: string;
  name: string;
}

export interface ReconnectRequest {
  token: string;
}

export interface BuildLineRequest {
  fromNodeId: string;
  targetX: number;
  targetY: number;
}

export interface RoomJoinedPayload {
  roomCode: string;
  playerId: string;
  reconnectToken: string;
  status: RoomStatus;
}

export interface LobbyPayload {
  roomCode: string;
  hostId: string | null;
  status: RoomStatus;
  players: PlayerPublic[];
}

export interface ErrorPayload {
  message: string;
}

export interface EventsPayload {
  events: GameEvent[];
}

/** socket.io event names, kept in one place so client and server cannot drift. */
export const C2S = {
  createRoom: 'createRoom',
  joinRoom: 'joinRoom',
  reconnect: 'reconnectPlayer',
  leaveRoom: 'leaveRoom',
  startGame: 'startGame',
  buildLine: 'buildLine',
} as const;

export const S2C = {
  roomJoined: 'roomJoined',
  lobby: 'lobby',
  snapshot: 'snapshot',
  events: 'events',
  error: 'errorMessage',
  kicked: 'kicked',
} as const;

export type { Snapshot, GameEvent, PlayerPublic, RoomStatus };
