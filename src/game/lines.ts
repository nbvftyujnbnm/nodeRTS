import { JUNCTION_MERGE_EPS } from '../shared/config';
import type { GameEdge, GameNode } from '../shared/types';
import { distance, segmentIntersection } from './geometry';
import { isolatedComponent, sortIds } from './graph';
import { resolveBuildTarget } from './target';
import { addEdge, addNode, type World } from './world';

export interface CutReport {
  victimId: string;
  edgeId: string;
  x: number;
  y: number;
}

export interface CaptureReport {
  victimId: string;
  nodeIds: string[];
  edgeIds: string[];
}

export interface HqCaptureReport {
  victimId: string;
  hqNodeId: string;
  /** Attacker node the line had reached when it arrived at the enemy HQ. */
  fromNodeId: string;
}

export interface LineReport {
  ok: boolean;
  reason?: string;
  createdNodeIds: string[];
  createdEdgeIds: string[];
  cuts: CutReport[];
  captures: CaptureReport[];
  hqCapture: HqCaptureReport | null;
  endNodeId: string | null;
}

export interface CompleteLineParams {
  ownerId: string;
  sourceNodeId: string;
  targetX: number;
  targetY: number;
  /** HQ node id for a player, or null when that player has none (dead). */
  hqOf: (playerId: string) => string | null;
  alivePlayerIds: ReadonlySet<string>;
}

interface Hit {
  edgeId: string;
  t: number;
  x: number;
  y: number;
}

/**
 * Turn a finished construction into real graph geometry.
 *
 * The new line is the attacker for every hostile crossing it makes. Crossings
 * are resolved strictly in order from the source towards the destination, so
 * the outcome is deterministic regardless of Map iteration order elsewhere.
 *
 * This function mutates the world but does not touch player/construction
 * bookkeeping; it reports what happened and the room applies the consequences.
 */
export function completeLine(world: World, params: CompleteLineParams): LineReport {
  const report: LineReport = {
    ok: false,
    createdNodeIds: [],
    createdEdgeIds: [],
    cuts: [],
    captures: [],
    hqCapture: null,
    endNodeId: null,
  };

  const source = world.nodes.get(params.sourceNodeId);
  if (!source) {
    report.reason = 'source node no longer exists';
    return report;
  }
  if (source.ownerId !== params.ownerId) {
    report.reason = 'source node no longer owned';
    return report;
  }

  // Re-resolve the target at completion time: the board may have changed while
  // the line was under construction.
  const target = resolveBuildTarget(
    world.nodes.values(),
    params.ownerId,
    source.id,
    params.targetX,
    params.targetY,
    params.alivePlayerIds,
  );

  const start = { x: source.x, y: source.y };
  const end = { x: target.x, y: target.y };

  const excluded = new Set<string>([source.id]);
  if (target.node) excluded.add(target.node.id);

  const hits = collectHits(world, start, end, excluded);

  let currentNodeId = source.id;

  for (const hit of hits) {
    const edge = world.edges.get(hit.edgeId);
    if (!edge) continue; // already consumed by an earlier crossing
    const point = { x: hit.x, y: hit.y };

    if (edge.ownerId === params.ownerId) {
      currentNodeId = resolveFriendlyCrossing(world, params.ownerId, edge, point, currentNodeId, report);
    } else {
      currentNodeId = resolveHostileCrossing(world, params, edge, point, currentNodeId, report);
    }
  }

  // Final leg.
  if (target.kind === 'enemyHq' && target.node) {
    report.hqCapture = {
      victimId: target.node.ownerId,
      hqNodeId: target.node.id,
      fromNodeId: currentNodeId,
    };
    report.endNodeId = target.node.id;
    report.ok = true;
    return report;
  }

  let endNodeId: string;
  if (target.kind === 'snap' && target.node) {
    endNodeId = target.node.id;
  } else {
    const created = addNode(world, params.ownerId, 'base', end.x, end.y, 0);
    report.createdNodeIds.push(created.id);
    endNodeId = created.id;
  }

  connect(world, params.ownerId, currentNodeId, endNodeId, report);
  report.endNodeId = endNodeId;
  report.ok = true;
  return report;
}

/** Every proper crossing of the new segment with existing edges, source-first. */
function collectHits(
  world: World,
  start: { x: number; y: number },
  end: { x: number; y: number },
  excludedNodeIds: ReadonlySet<string>,
): Hit[] {
  const hits: Hit[] = [];
  for (const edge of world.edges.values()) {
    if (excludedNodeIds.has(edge.nodeA) || excludedNodeIds.has(edge.nodeB)) continue;
    const a = world.nodes.get(edge.nodeA);
    const b = world.nodes.get(edge.nodeB);
    if (!a || !b) continue;
    const hit = segmentIntersection(start, end, a, b);
    if (!hit) continue;
    hits.push({ edgeId: edge.id, t: hit.t, x: hit.point.x, y: hit.point.y });
  }

  hits.sort((l, r) => {
    if (l.t !== r.t) return l.t - r.t;
    return sortIds([l.edgeId, r.edgeId])[0] === l.edgeId ? -1 : 1;
  });
  return hits;
}

/**
 * Crossing one of your own lines: drop a junction at the intersection, split
 * the crossed edge through it, and route the new line through it too. Arbitrary
 * crossing lines therefore become one connected logistics graph.
 */
function resolveFriendlyCrossing(
  world: World,
  ownerId: string,
  edge: GameEdge,
  point: { x: number; y: number },
  currentNodeId: string,
  report: LineReport,
): string {
  const junctionId = getOrCreateJunction(world, ownerId, point, report);
  if (junctionId !== edge.nodeA && junctionId !== edge.nodeB) {
    world.edges.delete(edge.id);
    connect(world, edge.ownerId, edge.nodeA, junctionId, report);
    connect(world, edge.ownerId, junctionId, edge.nodeB, report);
  }
  connect(world, ownerId, currentNodeId, junctionId, report);
  return junctionId;
}

/**
 * Crossing an enemy line: the enemy edge is severed outright, the attacker gets
 * its own junction at the crossing, and anything the victim can no longer reach
 * from their HQ is captured and wired into the attacker's network.
 *
 * The severed edge is removed rather than kept as two victim stubs, which is
 * what guarantees the victim cannot reconnect through the attacker's junction.
 */
function resolveHostileCrossing(
  world: World,
  params: CompleteLineParams,
  edge: GameEdge,
  point: { x: number; y: number },
  currentNodeId: string,
  report: LineReport,
): string {
  const victimId = edge.ownerId;
  const endpointA = edge.nodeA;
  const endpointB = edge.nodeB;

  world.edges.delete(edge.id);
  report.cuts.push({ victimId, edgeId: edge.id, x: point.x, y: point.y });

  const junctionId = getOrCreateJunction(world, params.ownerId, point, report);
  connect(world, params.ownerId, currentNodeId, junctionId, report);

  // Connectivity is recomputed immediately, from the victim's HQ, over the
  // victim's *remaining* edges. An alternate route saves the far side.
  const victimHq = params.hqOf(victimId);
  const isolated = isolatedComponent(world, victimId, victimHq);

  if (isolated.nodeIds.length > 0 || isolated.edgeIds.length > 0) {
    for (const nodeId of isolated.nodeIds) {
      const node = world.nodes.get(nodeId);
      if (!node) continue;
      node.ownerId = params.ownerId;
      node.stock = 0; // captured assets start empty
    }
    for (const edgeId of isolated.edgeIds) {
      const captured = world.edges.get(edgeId);
      if (captured) captured.ownerId = params.ownerId;
    }
    report.captures.push({ victimId, nodeIds: isolated.nodeIds, edgeIds: isolated.edgeIds });

    // Wire whichever severed endpoint was captured into the attacker's junction
    // so the new territory is actually supplied.
    const capturedSet = new Set(isolated.nodeIds);
    for (const endpoint of [endpointA, endpointB]) {
      if (capturedSet.has(endpoint)) connect(world, params.ownerId, junctionId, endpoint, report);
    }
  }

  return junctionId;
}

/** Reuse an owned node within a tiny epsilon, otherwise create a junction. */
function getOrCreateJunction(
  world: World,
  ownerId: string,
  point: { x: number; y: number },
  report: LineReport,
): string {
  let best: GameNode | null = null;
  let bestDist = Infinity;
  for (const node of world.nodes.values()) {
    if (node.ownerId !== ownerId) continue;
    const d = distance(point, node);
    if (d <= JUNCTION_MERGE_EPS && d < bestDist) {
      best = node;
      bestDist = d;
    }
  }
  if (best) return best.id;

  const created = addNode(world, ownerId, 'junction', point.x, point.y, 0);
  report.createdNodeIds.push(created.id);
  return created.id;
}

function connect(
  world: World,
  ownerId: string,
  a: string,
  b: string,
  report: LineReport,
): void {
  const edge = addEdge(world, ownerId, a, b);
  if (edge) report.createdEdgeIds.push(edge.id);
}

/** Exported for the room: wiring the attacker into a just-captured HQ. */
export function connectNodes(world: World, ownerId: string, a: string, b: string): GameEdge | null {
  return addEdge(world, ownerId, a, b);
}
