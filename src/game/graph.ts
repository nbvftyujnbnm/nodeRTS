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
export function reachableNodes(
  world: World,
  ownerId: string,
  startId: string,
  adjacencyIn?: Map<string, AdjacencyEntry[]>,
): Set<string> {
  const adjacency = adjacencyIn ?? buildAdjacency(world, ownerId);
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
 * A binary min-heap over (distance, nodeId), in flat arrays.
 *
 * The scan it replaces was O(V^2): at 600 nodes one player's Dijkstra cost
 * 120us and the supply pass alone ate 1.1ms of every 50ms tick.
 */
class MinHeap {
  private readonly keys: number[] = [];
  private readonly values: string[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: string): void {
    this.keys.push(key);
    this.values.push(value);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): { key: number; value: string } | undefined {
    if (this.keys.length === 0) return undefined;
    const key = this.keys[0];
    const value = this.values[0];
    const lastKey = this.keys.pop() as number;
    const lastValue = this.values.pop() as string;

    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.values[0] = lastValue;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.keys.length && this.keys[left] < this.keys[smallest]) smallest = left;
        if (right < this.keys.length && this.keys[right] < this.keys[smallest]) smallest = right;
        if (smallest === i) break;
        this.swap(smallest, i);
        i = smallest;
      }
    }
    return { key, value };
  }

  private swap(a: number, b: number): void {
    const key = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = key;
    const value = this.values[a];
    this.values[a] = this.values[b];
    this.values[b] = value;
  }
}

/**
 * Dijkstra over the player's own supply network, weighted by geometric edge
 * length. Returns route distance from `startId` for every reachable node.
 */
export function shortestDistances(
  world: World,
  ownerId: string,
  startId: string,
  adjacencyIn?: Map<string, AdjacencyEntry[]>,
): Map<string, number> {
  const adjacency = adjacencyIn ?? buildAdjacency(world, ownerId);
  const dist = new Map<string, number>();
  if (!adjacency.has(startId)) return dist;

  dist.set(startId, 0);
  const visited = new Set<string>();
  const heap = new MinHeap();
  heap.push(0, startId);

  for (;;) {
    const next = heap.pop();
    if (next === undefined) break;
    if (visited.has(next.value)) continue; // stale entry from an earlier relax
    visited.add(next.value);

    for (const entry of adjacency.get(next.value) ?? []) {
      const candidate = next.key + entry.length;
      const known = dist.get(entry.to);
      if (known === undefined || candidate < known - 1e-12) {
        dist.set(entry.to, candidate);
        heap.push(candidate, entry.to);
      }
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
