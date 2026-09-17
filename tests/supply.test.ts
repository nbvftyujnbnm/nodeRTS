import { describe, expect, it } from 'vitest';
import { shortestDistances } from '../src/game/graph';
import { simulateSupply } from '../src/game/supply';
import {
  BASE_TRANSFER_RATE,
  HQ_PRODUCTION_PER_SECOND,
  TRANSPORT_DISTANCE_PENALTY,
} from '../src/shared/config';
import { scenario } from './helpers';

const PLAYERS = [{ id: 'p1', alive: true }];

describe('shortest-path supply distance', () => {
  it('uses the shorter of two routes', () => {
    const s = scenario();
    const hq = s.node('p1', 'hq', 0, 0, 500);
    const detour = s.node('p1', 'base', 0, 300, 0);
    const target = s.node('p1', 'base', 400, 0, 0);
    s.link('p1', hq, detour); // 300
    s.link('p1', detour, target); // 500
    s.link('p1', hq, target); // 400 direct

    const distances = shortestDistances(s.world, 'p1', hq.id);
    expect(distances.get(target.id)).toBeCloseTo(400);
    expect(distances.get(detour.id)).toBeCloseTo(300);
  });

  it('measures along the graph, not straight-line', () => {
    const s = scenario();
    const hq = s.node('p1', 'hq', 0, 0, 500);
    const corner = s.node('p1', 'base', 0, 300, 0);
    const target = s.node('p1', 'base', 400, 300, 0);
    s.link('p1', hq, corner);
    s.link('p1', corner, target);

    const distances = shortestDistances(s.world, 'p1', hq.id);
    expect(distances.get(target.id)).toBeCloseTo(700); // 300 + 400, not 500
  });

  it('does not reach nodes behind an enemy-owned edge', () => {
    const s = scenario();
    const hq = s.node('p1', 'hq', 0, 0, 500);
    const mine = s.node('p1', 'base', 100, 0, 0);
    const theirs = s.node('p2', 'base', 200, 0, 0);
    s.link('p1', hq, mine);
    s.link('p2', mine, theirs);

    const distances = shortestDistances(s.world, 'p1', hq.id);
    expect(distances.has(mine.id)).toBe(true);
    expect(distances.has(theirs.id)).toBe(false);
  });
});

describe('resource simulation', () => {
  it('produces at the HQ and clamps to max stock', () => {
    const s = scenario();
    const hq = s.node('p1', 'hq', 0, 0, 100);
    simulateSupply(s.world, PLAYERS, 1);
    expect(hq.stock).toBeCloseTo(100 + HQ_PRODUCTION_PER_SECOND);

    hq.stock = 495;
    simulateSupply(s.world, PLAYERS, 1);
    expect(hq.stock).toBe(500);
  });

  it('delivers at most BASE_TRANSFER_RATE per second to a node', () => {
    const s = scenario();
    const hq = s.node('p1', 'hq', 0, 0, 500);
    const base = s.node('p1', 'base', 100, 0, 0);
    s.link('p1', hq, base);

    simulateSupply(s.world, PLAYERS, 1);
    expect(base.stock).toBeCloseTo(BASE_TRANSFER_RATE);
  });

  it('never supplies a node that is not connected to the HQ', () => {
    const s = scenario();
    s.node('p1', 'hq', 0, 0, 500);
    const orphan = s.node('p1', 'base', 100, 0, 0);

    simulateSupply(s.world, PLAYERS, 1);
    expect(orphan.stock).toBe(0);
  });

  /** Requirement 9: transport efficiency falls off with route length. */
  it('charges the HQ more for a longer route', () => {
    function run(routeLength: number): number {
      const s = scenario();
      const hq = s.node('p1', 'hq', 0, 0, 500);
      const base = s.node('p1', 'base', routeLength, 0, 0);
      s.link('p1', hq, base);
      simulateSupply(s.world, PLAYERS, 1);
      // delivered is identical (rate-capped); compare what the HQ paid.
      expect(base.stock).toBeCloseTo(BASE_TRANSFER_RATE);
      return 500 - hq.stock; // HQ was already at max, so production is clamped away
    }

    const near = run(100);
    const far = run(400);
    expect(far).toBeGreaterThan(near);

    const delivered = BASE_TRANSFER_RATE;
    expect(near).toBeCloseTo(delivered * (1 + TRANSPORT_DISTANCE_PENALTY * 100), 5);
    expect(far).toBeCloseTo(delivered * (1 + TRANSPORT_DISTANCE_PENALTY * 400), 5);
  });

  /** Requirement 10: scale deliveries proportionally, not by iteration order. */
  it('scales every delivery by the same factor when the HQ cannot pay', () => {
    const s = scenario();
    const hq = s.node('p1', 'hq', 0, 0, 0);
    const a = s.node('p1', 'base', 100, 0, 0);
    const b = s.node('p1', 'base', -100, 0, 0);
    const c = s.node('p1', 'base', 0, 100, 0);
    s.link('p1', hq, a);
    s.link('p1', hq, b);
    s.link('p1', hq, c);

    // Production for this tick is the only income: 24 * 0.5 = 12 available,
    // while the three nodes want 6 each (18 total) plus transport overhead.
    simulateSupply(s.world, PLAYERS, 0.5);

    expect(a.stock).toBeCloseTo(b.stock, 9);
    expect(b.stock).toBeCloseTo(c.stock, 9);
    expect(a.stock).toBeGreaterThan(0);
    expect(a.stock).toBeLessThan(BASE_TRANSFER_RATE * 0.5);
    expect(hq.stock).toBeCloseTo(0, 6);
  });

  it('is independent of node insertion order when rationing', () => {
    function run(reversed: boolean): number[] {
      const s = scenario();
      const hq = s.node('p1', 'hq', 0, 0, 0);
      const positions: Array<[number, number]> = [
        [100, 0],
        [200, 0],
        [300, 0],
      ];
      const order = reversed ? [...positions].reverse() : positions;
      const nodes = order.map(([x, y]) => {
        const node = s.node('p1', 'base', x, y, 0);
        s.link('p1', hq, node);
        return node;
      });
      simulateSupply(s.world, PLAYERS, 0.5);
      return nodes
        .map((n) => ({ x: n.x, stock: n.stock }))
        .sort((l, r) => l.x - r.x)
        .map((n) => Number(n.stock.toFixed(9)));
    }

    expect(run(false)).toEqual(run(true));
  });

  it('stops pulling once a node is at capacity', () => {
    const s = scenario();
    const hq = s.node('p1', 'hq', 0, 0, 500);
    const base = s.node('p1', 'base', 100, 0, 110);
    s.link('p1', hq, base);

    simulateSupply(s.world, PLAYERS, 1);
    expect(base.stock).toBe(110);
    expect(hq.stock).toBe(500);
  });

  it('skips eliminated players', () => {
    const s = scenario();
    const hq = s.node('p1', 'hq', 0, 0, 100);
    simulateSupply(s.world, [{ id: 'p1', alive: false }], 1);
    expect(hq.stock).toBe(100);
  });
});
