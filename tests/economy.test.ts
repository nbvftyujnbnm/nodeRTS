import { describe, expect, it } from 'vitest';
import { GameRoom } from '../src/game/room';
import { simulateSupply } from '../src/game/supply';
import { addEdge, addNode, createWorld, findHq } from '../src/game/world';
import {
  BASE_MAX_STOCK,
  HQ_PRODUCTION_PER_SECOND,
  NODE_PRODUCTION_PER_SECOND,
  TICK_INTERVAL_MS,
  buildCostForDistance,
} from '../src/shared/config';

/**
 * A mid-game network: four chains radiating inwards from the HQ, every node
 * inside the world and at a distinct position.
 */
function networkOf(nodesPerChain: number) {
  const room = new GameRoom({ code: 'ECON' });
  const me = room.addPlayer('A', 's1', 0);
  room.addPlayer('B', 's2', 0);
  if ('error' in me) throw new Error(me.error);
  room.start(0);
  const hq = findHq(room.world, me.id)!;

  for (const degrees of [165, 175, 185, 195]) {
    const angle = (degrees * Math.PI) / 180;
    let previous = hq;
    for (let i = 1; i <= nodesPerChain; i++) {
      const node = addNode(
        room.world,
        me.id,
        'base',
        hq.x + Math.cos(angle) * 180 * i,
        hq.y + Math.sin(angle) * 180 * i,
        0,
      );
      addEdge(room.world, me.id, previous.id, node.id);
      previous = node;
    }
  }
  const bases = [...room.world.nodes.values()].filter((n) => n.ownerId === me.id && n.type !== 'hq');
  return { room, hq, ownerId: me.id, bases };
}

function run(room: GameRoom, seconds: number): void {
  let now = 0;
  for (let i = 0; i < (seconds * 1000) / TICK_INTERVAL_MS; i++) {
    now += TICK_INTERVAL_MS;
    room.tick(now);
  }
}

describe('late-game economy', () => {
  /**
   * The stalemate this guards against: production was a flat 24/s no matter how
   * much territory you held, while every node pulled towards capacity at once.
   * A 20-node network diluted that income twenty ways, so the HQ sat pinned at
   * zero and not one node could afford even a medium build. Both players simply
   * stopped being able to do anything.
   */
  it('leaves a large network able to act', () => {
    const { room, bases } = networkOf(5);
    expect(bases).toHaveLength(20);
    run(room, 25);

    const mediumBuild = buildCostForDistance(300);
    const funded = bases.filter((b) => b.stock >= mediumBuild).length;
    expect(funded).toBeGreaterThanOrEqual(bases.length * 0.8);
  });

  it('does not leave the HQ permanently drained', () => {
    const { room, hq } = networkOf(3);
    run(room, 40);
    expect(hq.stock).toBeGreaterThan(buildCostForDistance(450));
  });

  /**
   * Territory has to be worth something, or there is no engine to break a tie:
   * whoever is ahead should out-produce, and the game should resolve.
   */
  it('produces more the more territory is supplied', () => {
    function incomeWith(nodeCount: number): number {
      const world = createWorld();
      const hq = addNode(world, 'p1', 'hq', 200, 450, 0);
      let previous = hq;
      for (let i = 1; i <= nodeCount; i++) {
        // Full, so nothing is requested and all income stays at the HQ.
        const node = addNode(world, 'p1', 'base', 200 + i * 100, 450, BASE_MAX_STOCK);
        addEdge(world, 'p1', previous.id, node.id);
        previous = node;
      }
      simulateSupply(world, [{ id: 'p1', alive: true }], 1);
      return hq.stock;
    }

    expect(incomeWith(0)).toBeCloseTo(HQ_PRODUCTION_PER_SECOND, 5);
    expect(incomeWith(5)).toBeCloseTo(HQ_PRODUCTION_PER_SECOND + 5 * NODE_PRODUCTION_PER_SECOND, 5);
    expect(incomeWith(10)).toBeGreaterThan(incomeWith(5));
  });

  /**
   * The payoff that ties the economy to the core mechanic: cutting an enemy
   * network does not just take ground, it takes their income, because only
   * nodes still reachable from their HQ produce.
   */
  it('stops paying for territory that has been cut off', () => {
    const world = createWorld();
    const hq = addNode(world, 'p1', 'hq', 200, 450, 0);
    const link = addNode(world, 'p1', 'base', 300, 450, BASE_MAX_STOCK);
    addEdge(world, 'p1', hq.id, link.id);
    let previous = link;
    for (let i = 2; i <= 6; i++) {
      const node = addNode(world, 'p1', 'base', 200 + i * 100, 450, BASE_MAX_STOCK);
      addEdge(world, 'p1', previous.id, node.id);
      previous = node;
    }

    simulateSupply(world, [{ id: 'p1', alive: true }], 1);
    const connectedIncome = hq.stock;
    expect(connectedIncome).toBeCloseTo(HQ_PRODUCTION_PER_SECOND + 6 * NODE_PRODUCTION_PER_SECOND, 5);

    // Sever the link next to the HQ: the player still owns six nodes, but none
    // of them reach the HQ any more.
    hq.stock = 0;
    for (const [id, edge] of [...world.edges]) {
      if (edge.nodeA === hq.id || edge.nodeB === hq.id) world.edges.delete(id);
    }
    simulateSupply(world, [{ id: 'p1', alive: true }], 1);

    expect(hq.stock).toBeCloseTo(HQ_PRODUCTION_PER_SECOND, 5);
    expect(hq.stock).toBeLessThan(connectedIncome);
  });
});
