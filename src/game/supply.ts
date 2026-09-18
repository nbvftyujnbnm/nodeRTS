import {
  BASE_TRANSFER_RATE,
  HQ_MAX_STOCK,
  HQ_PRODUCTION_PER_SECOND,
  NODE_PRODUCTION_PER_SECOND,
  TRANSPORT_DISTANCE_PENALTY,
  capacityForNodeType,
  producesIncome,
} from '../shared/config';
import type { GameNode } from '../shared/types';
import { shortestDistances } from './graph';
import { findHq, type World } from './world';

export interface SupplyPlayer {
  id: string;
  alive: boolean;
}

export interface SupplyResult {
  /** Route distance from each player's HQ to each of their reachable nodes. */
  distances: Map<string, Map<string, number>>;
}

interface Request {
  node: GameNode;
  want: number;
  costAtHq: number;
}

/**
 * One tick of the resource model.
 *
 * Production happens at the HQ and scales with how many supplied bases its
 * owner still holds. Bases pull towards their capacity through the live supply
 * graph, and long routes cost the HQ more than they deliver. Junctions hold
 * nothing and produce nothing; they only conduct. When the HQ cannot pay for
 * everything requested this tick, every delivery is scaled by the same factor,
 * so no node is privileged by iteration order.
 */
export function simulateSupply(
  world: World,
  players: readonly SupplyPlayer[],
  dtSeconds: number,
): SupplyResult {
  const distances = new Map<string, Map<string, number>>();
  if (dtSeconds <= 0) return { distances };

  for (const player of players) {
    if (!player.alive) continue;
    const hq = findHq(world, player.id);
    if (!hq) continue;

    // 3 + 4 first: only nodes reachable through owned edges are supplied, and
    // how many there are decides this tick's production.
    const dist = shortestDistances(world, player.id, hq.id);
    distances.set(player.id, dist);

    // 1 + 2: produce and clamp. Supplied territory feeds the HQ, so a network
    // that has been cut apart produces less. Only bases count - junctions are
    // wiring that appears for free wherever lines cross.
    let producers = 0;
    for (const nodeId of dist.keys()) {
      const node = world.nodes.get(nodeId);
      if (node && node.id !== hq.id && producesIncome(node.type)) producers++;
    }
    const income = HQ_PRODUCTION_PER_SECOND + producers * NODE_PRODUCTION_PER_SECOND;
    hq.stock = Math.min(HQ_MAX_STOCK, hq.stock + income * dtSeconds);

    // 5: gather requests.
    const requests: Request[] = [];
    let totalCostAtHq = 0;
    for (const [nodeId, routeDistance] of dist) {
      if (nodeId === hq.id) continue;
      const node = world.nodes.get(nodeId);
      if (!node) continue;
      const capacity = capacityForNodeType(node.type);
      const want = Math.min(capacity - node.stock, BASE_TRANSFER_RATE * dtSeconds);
      if (want <= 0) continue;
      const costAtHq = want * (1 + TRANSPORT_DISTANCE_PENALTY * routeDistance);
      requests.push({ node, want, costAtHq });
      totalCostAtHq += costAtHq;
    }

    if (requests.length === 0 || totalCostAtHq <= 0) continue;

    const scale = totalCostAtHq <= hq.stock ? 1 : hq.stock / totalCostAtHq;
    let spent = 0;
    for (const request of requests) {
      request.node.stock += request.want * scale;
      spent += request.costAtHq * scale;
    }
    hq.stock = Math.max(0, hq.stock - spent);
  }

  return { distances };
}
