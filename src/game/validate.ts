import {
  BUILD_DISTANCE_COST,
  HQ_ASSAULT_COST_MULTIPLIER,
  HQ_ASSAULT_MAX_RANGE,
  HQ_ASSAULT_TIME_MULTIPLIER,
  MAX_ACTIVE_CONSTRUCTIONS_PER_NODE,
  MAX_ACTIVE_CONSTRUCTIONS_PER_PLAYER,
  MAX_BUILD_DISTANCE,
  MIN_BUILD_DISTANCE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  buildCostForDistance,
  buildTimeForDistance,
} from '../shared/config';
import type { GameNode } from '../shared/types';
import { distance, isFiniteNumber } from './geometry';
import { resolveBuildTarget, type ResolvedTarget } from './target';

export interface BuildContext {
  playerId: string;
  /** Whether the requesting player is alive. */
  alive: boolean;
  nodes: Iterable<GameNode>;
  getNode(id: string): GameNode | undefined;
  /** Owner nodes currently reachable from the owner's HQ (server-computed). */
  isConnectedToHq(nodeId: string): boolean;
  activeConstructionsForPlayer: number;
  activeConstructionsOnNode(nodeId: string): number;
  alivePlayerIds: ReadonlySet<string>;
}

export interface BuildEvaluation {
  ok: boolean;
  reason: string | null;
  distance: number;
  cost: number;
  buildTime: number;
  target: ResolvedTarget | null;
}

function fail(reason: string, dist = 0, cost = 0, target: ResolvedTarget | null = null): BuildEvaluation {
  return { ok: false, reason, distance: dist, cost, buildTime: 0, target };
}

/**
 * Full build validation. The server runs this as the authority; the client runs
 * the identical function purely to colour its preview line.
 */
export function evaluateBuild(
  ctx: BuildContext,
  fromNodeId: unknown,
  targetX: unknown,
  targetY: unknown,
): BuildEvaluation {
  if (typeof fromNodeId !== 'string' || fromNodeId.length === 0 || fromNodeId.length > 64) {
    return fail('invalid source node id');
  }
  if (!isFiniteNumber(targetX) || !isFiniteNumber(targetY)) {
    return fail('invalid target coordinates');
  }
  if (targetX < 0 || targetX > WORLD_WIDTH || targetY < 0 || targetY > WORLD_HEIGHT) {
    return fail('target outside world bounds');
  }
  if (!ctx.alive) return fail('you have been eliminated');

  const source = ctx.getNode(fromNodeId);
  if (!source) return fail('source node does not exist');
  if (source.ownerId !== ctx.playerId) return fail('source node is not yours');
  // Junctions are wiring: they carry supply past a crossing but store none of
  // it, so there is nothing there to pay for a line.
  if (source.type === 'junction') return fail('junctions only relay - build from a base or HQ');
  if (!ctx.isConnectedToHq(source.id)) return fail('source is not supplied by your HQ');

  if (ctx.activeConstructionsForPlayer >= MAX_ACTIVE_CONSTRUCTIONS_PER_PLAYER) {
    return fail(`max ${MAX_ACTIVE_CONSTRUCTIONS_PER_PLAYER} constructions at once`);
  }
  if (ctx.activeConstructionsOnNode(source.id) >= MAX_ACTIVE_CONSTRUCTIONS_PER_NODE) {
    return fail('this node is already building');
  }

  const target = resolveBuildTarget(
    ctx.nodes,
    ctx.playerId,
    source.id,
    targetX,
    targetY,
    ctx.alivePlayerIds,
  );

  if (target.node && target.node.id === source.id) return fail('target is the source node');

  const dist = distance(source, { x: target.x, y: target.y });
  const assault = target.kind === 'enemyHq';
  const cost = buildCostForDistance(dist) * (assault ? HQ_ASSAULT_COST_MULTIPLIER : 1);
  const buildTime = buildTimeForDistance(dist) * (assault ? HQ_ASSAULT_TIME_MULTIPLIER : 1);

  if (dist < MIN_BUILD_DISTANCE) return fail(`too close (min ${MIN_BUILD_DISTANCE})`, dist, cost, target);
  if (dist > MAX_BUILD_DISTANCE) return fail(`too far (max ${MAX_BUILD_DISTANCE})`, dist, cost, target);
  if (assault && dist > HQ_ASSAULT_MAX_RANGE) {
    return fail(`get within ${HQ_ASSAULT_MAX_RANGE} to storm an HQ`, dist, cost, target);
  }
  if (source.stock < cost) return fail('not enough resources at source', dist, cost, target);

  return { ok: true, reason: null, distance: dist, cost, buildTime, target };
}

export { BUILD_DISTANCE_COST };
export type { ResolvedTarget };
