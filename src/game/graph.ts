import type { GameNode } from '../shared/types';
import type { World } from './world';

export interface AdjacencyEntry {
  to: string;
  edgeId: string;
  length: number;
}

/**
 * Adjacency restricted to a single player's edges. An edge is only traversable
 * when the player owns the edge *and* both of its endpoints, which keeps
 * half-captured geometry from silently reconnecting a network.
 */
export function buildAdjacency(world: World, ownerId: string): Map<string, AdjacencyEntry[]> {
  const adjacency = new Map<string, AdjacencyEntry[]>();
  for (const node of world.nodes.values()) {
    if (node.ownerId === ownerId) adjacency.set(node.id, []);
  }
  for (const edge of world.edges.values()) {
    if (edge.ownerId !== ownerId) continue;
    const a = adjacency.get(edge.nodeA);
    const b = adjacency.get(edge.nodeB);
    if (!a || !b) continue;
    a.push({ to: edge.nodeB, edgeId: edge.id, length: edge.length });
    b.push({ to: edge.nodeA, edgeId: edge.id, length: edge.length });
  }
  return adjacency;
}

/** Set of a player's nodes reachable from `startId` over that player's edges. */
export function reachableNodes(world: World, ownerId: string, startId: string): Set<string> {
  const adjacency = buildAdjacency(world, ownerId);
  const seen = new Set<string>();
  if (!adjacency.has(startId)) return seen;

  const stack = [startId];
  seen.add(startId);
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of adjacency.get(current) ?? []) {
      if (!seen.has(entry.to)) {
        seen.add(entry.to);
        stack.push(entry.to);
      }
    }
  }
  return seen;
}

/**
 * Dijkstra over the player's own supply network, weighted by geometric edge
 * length. Returns route distance from `startId` for every reachable node.
 */
export function shortestDistances(
  world: World,
  ownerId: string,
  startId: string,
): Map<string, number> {
  const adjacency = buildAdjacency(world, ownerId);
  const dist = new Map<string, number>();
  if (!adjacency.has(startId)) return dist;

  dist.set(startId, 0);
  const visited = new Set<string>();

  // Small graphs (tens of nodes): a linear scan beats a heap in both speed and
  // bug surface.
  for (;;) {
    let best: string | null = null;
    let bestDist = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < bestDist) {
        best = id;
        bestDist = d;
      }
    }
    if (best === null) break;
    visited.add(best);

    for (const entry of adjacency.get(best) ?? []) {
      const next = bestDist + entry.length;
      const known = dist.get(entry.to);
      if (known === undefined || next < known - 1e-12) dist.set(entry.to, next);
    }
  }
  return dist;
}

/**
 * The victim-side nodes/edges that no longer reach `hqNodeId`. Sorted for
 * deterministic event payloads.
 */
export function isolatedComponent(
  world: World,
  ownerId: string,
  hqNodeId: string | null,
): { nodeIds: string[]; edgeIds: string[] } {
  const reachable = hqNodeId ? reachableNodes(world, ownerId, hqNodeId) : new Set<string>();
  const nodeIds: string[] = [];
  for (const node of world.nodes.values()) {
    if (node.ownerId === ownerId && !reachable.has(node.id)) nodeIds.push(node.id);
  }
  const isolated = new Set(nodeIds);
  const edgeIds: string[] = [];
  for (const edge of world.edges.values()) {
    if (edge.ownerId !== ownerId) continue;
    if (isolated.has(edge.nodeA) || isolated.has(edge.nodeB)) edgeIds.push(edge.id);
  }
  return { nodeIds: sortIds(nodeIds), edgeIds: sortIds(edgeIds) };
}

export function sortIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const na = Number(a.slice(1));
    const nb = Number(b.slice(1));
    if (Number.isFinite(na) && Number.isFinite(nb) && a[0] === b[0]) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function nodeById(world: World, id: string): GameNode | undefined {
  return world.nodes.get(id);
}
