import type { Construction, EdgeSnapshot, NodeSnapshot, PlayerPublic, Snapshot } from './types';

/**
 * Only what changed since the last broadcast.
 *
 * Full snapshots were costing a client half a megabyte a second in a six
 * player match, because almost all of it - positions, owners, types, and the
 * stock of every node already sitting at capacity - is identical tick after
 * tick.
 */
export interface SnapshotDelta {
  full: false;
  roomCode: string;
  status: Snapshot['status'];
  serverTime: number;
  winnerId: string | null;
  hostId: string | null;
  players?: PlayerPublic[];
  nodes?: NodeSnapshot[];
  removedNodes?: string[];
  edges?: EdgeSnapshot[];
  removedEdges?: string[];
  /** Always sent: there are only ever a handful and they drive animation. */
  constructions: Construction[];
}

export type FullSnapshot = Snapshot & { full: true };
export type SnapshotMessage = FullSnapshot | SnapshotDelta;

function nodeDiffers(a: NodeSnapshot, b: NodeSnapshot): boolean {
  return (
    a.ownerId !== b.ownerId ||
    a.type !== b.type ||
    a.x !== b.x ||
    a.y !== b.y ||
    a.stock !== b.stock ||
    a.connected !== b.connected
  );
}

function edgeDiffers(a: EdgeSnapshot, b: EdgeSnapshot): boolean {
  return a.ownerId !== b.ownerId || a.nodeA !== b.nodeA || a.nodeB !== b.nodeB;
}

function playersDiffer(a: PlayerPublic[], b: PlayerPublic[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.color !== y.color ||
      x.alive !== y.alive ||
      x.connected !== y.connected ||
      x.isHost !== y.isHost
    ) {
      return true;
    }
  }
  return false;
}

/** The message to broadcast, given what the room last sent. */
export function diffSnapshot(previous: Snapshot | null, next: Snapshot): SnapshotMessage {
  if (!previous) return { ...next, full: true };

  const delta: SnapshotDelta = {
    full: false,
    roomCode: next.roomCode,
    status: next.status,
    serverTime: next.serverTime,
    winnerId: next.winnerId,
    hostId: next.hostId,
    constructions: next.constructions,
  };

  if (playersDiffer(previous.players, next.players)) delta.players = next.players;

  const beforeNodes = new Map(previous.nodes.map((n) => [n.id, n]));
  const changedNodes: NodeSnapshot[] = [];
  for (const node of next.nodes) {
    const was = beforeNodes.get(node.id);
    if (!was || nodeDiffers(was, node)) changedNodes.push(node);
    beforeNodes.delete(node.id);
  }
  if (changedNodes.length > 0) delta.nodes = changedNodes;
  if (beforeNodes.size > 0) delta.removedNodes = [...beforeNodes.keys()];

  const beforeEdges = new Map(previous.edges.map((e) => [e.id, e]));
  const changedEdges: EdgeSnapshot[] = [];
  for (const edge of next.edges) {
    const was = beforeEdges.get(edge.id);
    if (!was || edgeDiffers(was, edge)) changedEdges.push(edge);
    beforeEdges.delete(edge.id);
  }
  if (changedEdges.length > 0) delta.edges = changedEdges;
  if (beforeEdges.size > 0) delta.removedEdges = [...beforeEdges.keys()];

  return delta;
}

/**
 * Rebuild the client's view. A full message replaces everything; a delta is
 * merged onto what is already there.
 *
 * Returns null for a delta with no base, which can only happen if a keyframe
 * was missed - the caller waits for the next one rather than rendering a
 * half-built board.
 */
export function applySnapshotMessage(
  base: Snapshot | null,
  message: SnapshotMessage,
): Snapshot | null {
  if (message.full) {
    const { full: _full, ...snapshot } = message;
    return snapshot;
  }
  if (!base) return null;

  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  if (message.removedNodes) for (const id of message.removedNodes) nodes.delete(id);
  if (message.nodes) for (const node of message.nodes) nodes.set(node.id, node);

  const edges = new Map(base.edges.map((e) => [e.id, e]));
  if (message.removedEdges) for (const id of message.removedEdges) edges.delete(id);
  if (message.edges) for (const edge of message.edges) edges.set(edge.id, edge);

  return {
    roomCode: message.roomCode,
    status: message.status,
    serverTime: message.serverTime,
    winnerId: message.winnerId,
    hostId: message.hostId,
    players: message.players ?? base.players,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    constructions: message.constructions,
  };
}
