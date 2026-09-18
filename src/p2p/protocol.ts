import type { SnapshotMessage } from '../shared/delta';
import type { GameEvent, PlayerPublic, RoomStatus } from '../shared/types';

/**
 * Wire format for peer-to-peer matches.
 *
 * In P2P mode one player's browser runs the authoritative simulation and every
 * other player is a guest talking to it over a WebRTC data channel. The shapes
 * mirror the Socket.IO protocol so the client UI does not care which is in use.
 */
export type GuestToHost =
  | { t: 'hello'; name: string }
  | { t: 'resume'; token: string }
  | { t: 'build'; fromNodeId: unknown; targetX: unknown; targetY: unknown }
  | { t: 'start' }
  | { t: 'bye' };

export type HostToGuest =
  | { t: 'joined'; roomCode: string; playerId: string; reconnectToken: string; status: RoomStatus }
  | { t: 'lobby'; roomCode: string; hostId: string | null; status: RoomStatus; players: PlayerPublic[] }
  | { t: 'snap'; snapshot: SnapshotMessage }
  | { t: 'events'; events: GameEvent[] }
  | { t: 'err'; message: string }
  | { t: 'kick'; message: string };

/**
 * Room codes are turned into broker peer ids. The prefix namespaces them on the
 * shared public PeerJS broker so a 4-letter code does not collide with an
 * unrelated application's peer.
 */
export const PEER_ID_PREFIX = 'noderts-v1-';

export function peerIdForCode(code: string): string {
  return `${PEER_ID_PREFIX}${code.toUpperCase()}`;
}
