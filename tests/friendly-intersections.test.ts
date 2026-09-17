import { describe, expect, it } from 'vitest';
import { completeLine } from '../src/game/lines';
import { reachableNodes, shortestDistances } from '../src/game/graph';
import { edgeBetween, ownedNodes, scenario } from './helpers';

const ALIVE = new Set(['p1', 'p2']);

/**
 * Requirement 1 + 2: crossing your own line must create a junction and split
 * both lines through it, turning arbitrary crossings into one graph.
 */
describe('friendly intersections', () => {
  function crossingSetup() {
    const s = scenario();
    const hq = s.node('p1', 'hq', 200, 400, 500);
    const a = s.node('p1', 'base', 300, 200, 50);
    const b = s.node('p1', 'base', 300, 600, 50);
    s.link('p1', a, b); // vertical line at x=300
    const src = s.node('p1', 'base', 200, 400, 100);
    // src is the HQ position; use a separate source to keep the HQ intact.
    return { s, hq, a, b, src };
  }

  it('creates a junction at the crossing point', () => {
    const { s, src } = crossingSetup();
    const report = completeLine(s.world, {
      ownerId: 'p1',
      sourceNodeId: src.id,
      targetX: 400,
      targetY: 400,
      hqOf: s.hqOf,
      alivePlayerIds: ALIVE,
    });

    expect(report.ok).toBe(true);
    const junctions = ownedNodes(s.world, 'p1').filter((n) => n.type === 'junction');
    expect(junctions).toHaveLength(1);
    expect(junctions[0].x).toBeCloseTo(300);
    expect(junctions[0].y).toBeCloseTo(400);
    expect(junctions[0].ownerId).toBe('p1');
    expect(junctions[0].stock).toBe(0);
  });

  it('splits the crossed edge and routes the new line through the junction', () => {
    const { s, a, b, src } = crossingSetup();
    const originalEdgeId = [...s.world.edges.values()][0].id;

    completeLine(s.world, {
      ownerId: 'p1',
      sourceNodeId: src.id,
      targetX: 400,
      targetY: 400,
      hqOf: s.hqOf,
      alivePlayerIds: ALIVE,
    });

    const junction = ownedNodes(s.world, 'p1').find((n) => n.type === 'junction');
    expect(junction).toBeDefined();
    const j = junction!.id;

    // Original edge is gone, replaced by two halves.
    expect(s.world.edges.has(originalEdgeId)).toBe(false);
    const half1 = edgeBetween(s.world, a.id, j);
    const half2 = edgeBetween(s.world, j, b.id);
    expect(half1).toBeDefined();
    expect(half2).toBeDefined();
    expect(half1!.length).toBeCloseTo(200);
    expect(half2!.length).toBeCloseTo(200);
    expect(half1!.ownerId).toBe('p1');

    // The new line is also split at the junction.
    expect(edgeBetween(s.world, src.id, j)).toBeDefined();
    const endNode = ownedNodes(s.world, 'p1').find((n) => n.x === 400 && n.y === 400);
    expect(endNode).toBeDefined();
    expect(edgeBetween(s.world, j, endNode!.id)).toBeDefined();
  });

  it('makes the junction a usable, supplied part of the network', () => {
    const { s, hq, a, b, src } = crossingSetup();
    s.link('p1', hq, a); // HQ feeds the vertical line
    void b;

    completeLine(s.world, {
      ownerId: 'p1',
      sourceNodeId: src.id,
      targetX: 400,
      targetY: 400,
      hqOf: s.hqOf,
      alivePlayerIds: ALIVE,
    });

    const junction = ownedNodes(s.world, 'p1').find((n) => n.type === 'junction')!;
    const reachable = reachableNodes(s.world, 'p1', hq.id);
    expect(reachable.has(junction.id)).toBe(true);

    // And it can serve as a source: it has a finite supply distance.
    const distances = shortestDistances(s.world, 'p1', hq.id);
    expect(distances.get(junction.id)).toBeGreaterThan(0);
    expect(Number.isFinite(distances.get(junction.id)!)).toBe(true);
  });

  it('reuses a junction when a second crossing lands within epsilon', () => {
    const s = scenario();
    s.node('p1', 'hq', 100, 100, 500);
    const a = s.node('p1', 'base', 300, 200, 10);
    const b = s.node('p1', 'base', 300, 600, 10);
    s.link('p1', a, b);
    const src1 = s.node('p1', 'base', 200, 400, 100);
    const src2 = s.node('p1', 'base', 200, 400.5, 100);

    completeLine(s.world, {
      ownerId: 'p1',
      sourceNodeId: src1.id,
      targetX: 400,
      targetY: 400,
      hqOf: s.hqOf,
      alivePlayerIds: ALIVE,
    });
    // A second line crossing 0.5px from the first crossing point.
    completeLine(s.world, {
      ownerId: 'p1',
      sourceNodeId: src2.id,
      targetX: 400,
      targetY: 400.5,
      hqOf: s.hqOf,
      alivePlayerIds: ALIVE,
    });

    const junctions = ownedNodes(s.world, 'p1').filter((n) => n.type === 'junction');
    expect(junctions).toHaveLength(1);
    expect(junctions[0].x).toBeCloseTo(300);
    expect(junctions[0].y).toBeCloseTo(400);
    // No zero-length leftovers anywhere.
    for (const edge of s.world.edges.values()) expect(edge.length).toBeGreaterThan(0.5);
  });

  it('never creates duplicate edges between the same pair of nodes', () => {
    const s = scenario();
    s.node('p1', 'hq', 100, 100, 500);
    const a = s.node('p1', 'base', 400, 400, 100);
    const b = s.node('p1', 'base', 600, 400, 100);
    s.link('p1', a, b);
    s.link('p1', a, b); // duplicate attempt

    const pairs = [...s.world.edges.values()].filter(
      (e) =>
        (e.nodeA === a.id && e.nodeB === b.id) || (e.nodeA === b.id && e.nodeB === a.id),
    );
    expect(pairs).toHaveLength(1);
  });
});
