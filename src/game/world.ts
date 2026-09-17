import { MIN_EDGE_LENGTH } from '../shared/config';
import type { GameEdge, GameNode, NodeType } from '../shared/types';
import { distance } from './geometry';

/**
 * The authoritative node/edge store. All ids are created here (never by a
 * client) and come from monotonic counters, which keeps every mutation
 * deterministic and therefore testable.
 */
export interface World {
  nodes: Map<string, GameNode>;
  edges: Map<string, GameEdge>;
  nextNodeId(): string;
  nextEdgeId(): string;
}

export function createWorld(): World {
  let nodeCounter = 0;
  let edgeCounter = 0;
  return {
    nodes: new Map(),
    edges: new Map(),
    nextNodeId: () => `n${++nodeCounter}`,
    nextEdgeId: () => `e${++edgeCounter}`,
  };
}

export function addNode(
  world: World,
  ownerId: string,
  type: NodeType,
  x: number,
  y: number,
  stock = 0,
): GameNode {
  const node: GameNode = { id: world.nextNodeId(), ownerId, type, x, y, stock };
  world.nodes.set(node.id, node);
  return node;
}

export function findEdgeBetween(world: World, a: string, b: string): GameEdge | undefined {
  for (const edge of world.edges.values()) {
    if ((edge.nodeA === a && edge.nodeB === b) || (edge.nodeA === b && edge.nodeB === a)) {
      return edge;
    }
  }
  return undefined;
}

/**
 * Create an edge between two existing nodes.
 *
 * Refuses degenerate cases: self loops, zero-length edges and duplicates
 * between the same unordered pair (so players can build redundant *routes*
 * without stacking identical edges).
 */
export function addEdge(world: World, ownerId: string, a: string, b: string): GameEdge | null {
  if (a === b) return null;
  const nodeA = world.nodes.get(a);
  const nodeB = world.nodes.get(b);
  if (!nodeA || !nodeB) return null;
  const length = distance(nodeA, nodeB);
  if (length < MIN_EDGE_LENGTH) return null;
  if (findEdgeBetween(world, a, b)) return null;

  const edge: GameEdge = { id: world.nextEdgeId(), ownerId, nodeA: a, nodeB: b, length };
  world.edges.set(edge.id, edge);
  return edge;
}

export function removeEdge(world: World, edgeId: string): void {
  world.edges.delete(edgeId);
}

/** Remove a node and every edge touching it. */
export function removeNode(world: World, nodeId: string): void {
  world.nodes.delete(nodeId);
  for (const [id, edge] of world.edges) {
    if (edge.nodeA === nodeId || edge.nodeB === nodeId) world.edges.delete(id);
  }
}

export function nodesOf(world: World, ownerId: string): GameNode[] {
  return [...world.nodes.values()].filter((n) => n.ownerId === ownerId);
}

export function findHq(world: World, ownerId: string): GameNode | undefined {
  for (const node of world.nodes.values()) {
    if (node.ownerId === ownerId && node.type === 'hq') return node;
  }
  return undefined;
}
