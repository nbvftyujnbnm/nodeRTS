export type NodeType = 'hq' | 'base' | 'junction';
export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface GameNode {
  id: string;
  ownerId: string;
  type: NodeType;
  x: number;
  y: number;
  stock: number;
}

export interface GameEdge {
  id: string;
  ownerId: string;
  nodeA: string;
  nodeB: string;
  /** Geometric length in world pixels. */
  length: number;
}

export interface Construction {
  id: string;
  ownerId: string;
  sourceNodeId: string;
  /** Target position, already snapped at request time by the server. */
  targetX: number;
  targetY: number;
  /** Node the target snapped onto at request time, if any (re-resolved on completion). */
  targetNodeId: string | null;
  startTime: number;
  finishTime: number;
  cost: number;
  distance: number;
  /**
   * Set when this line is a direct assault on that player's headquarters.
   *
   * Carried on the construction rather than only announced as an event, so a
   * client that joins, reconnects or misses a packet still knows from the next
   * snapshot that an HQ is under attack.
   */
  assaultOnPlayerId: string | null;
}

export interface PlayerPublic {
  id: string;
  name: string;
  color: string;
  alive: boolean;
  connected: boolean;
  isHost: boolean;
}

/** A node as broadcast to clients: includes server-computed supply state. */
export interface NodeSnapshot extends GameNode {
  /** True when the server's Dijkstra pass reached this node from its owner's HQ. */
  connected: boolean;
  capacity: number;
}

export interface Snapshot {
  roomCode: string;
  status: RoomStatus;
  serverTime: number;
  players: PlayerPublic[];
  nodes: NodeSnapshot[];
  edges: GameEdge[];
  constructions: Construction[];
  winnerId: string | null;
  hostId: string | null;
}

export type GameEvent =
  | { type: 'playerJoined'; playerId: string; name: string }
  | { type: 'playerLeft'; playerId: string; name: string }
  | { type: 'playerDisconnected'; playerId: string; name: string }
  | { type: 'playerReconnected'; playerId: string; name: string }
  | { type: 'matchStarted' }
  | { type: 'constructionStarted'; constructionId: string; playerId: string; sourceNodeId: string; x: number; y: number }
  | { type: 'hqAssaultStarted'; constructionId: string; attackerId: string; victimId: string; finishTime: number }
  | { type: 'constructionCompleted'; constructionId: string; playerId: string }
  | { type: 'constructionCancelled'; constructionId: string; playerId: string; reason: string }
  | { type: 'supplyLineCut'; attackerId: string; victimId: string; edgeId: string; x: number; y: number }
  | { type: 'networkCaptured'; attackerId: string; victimId: string; nodeIds: string[]; edgeIds: string[] }
  | { type: 'hqCaptured'; attackerId: string; victimId: string }
  | { type: 'playerEliminated'; playerId: string; reason: 'hq' | 'disconnect' }
  | { type: 'victory'; winnerId: string | null };

export interface TimedGameEvent {
  /** Server timestamp in ms. */
  t: number;
  event: GameEvent;
}
