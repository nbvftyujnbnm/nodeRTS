import { describe, expect, it } from 'vitest';
import { completeLine } from '../src/game/lines';
import { edgeBetween, ownedNodes, scenario } from './helpers';

const ALIVE = new Set(['p1', 'p2']);

/**
 * The core mechanic. Victim p2 owns a chain:
 *
 *   HQ -- A -- B -- C     (all at y = 100)
 *
 * Attacker p1 builds a vertical line at x = 400, cutting A--B at (400, 100).
 */
function bridgeSetup() {
  const s = scenario();
  const victimHq = s.node('p2', 'hq', 100, 100, 400);
  const a = s.node('p2', 'base', 300, 100, 40);
  const b = s.node('p2', 'base', 500, 100, 60);
  const c = s.node('p2', 'base', 700, 100, 80);
  s.link('p2', victimHq, a);
  s.link('p2', a, b);
  s.link('p2', b, c);

  s.node('p1', 'hq', 400, 700, 500);
  const attackerSrc = s.node('p1', 'base', 400, 300, 200);
  return { s, victimHq, a, b, c, attackerSrc };
}

function attack(s: ReturnType<typeof scenario>, sourceId: string, x: number, y: number) {
  return completeLine(s.world, {
    ownerId: 'p1',
    sourceNodeId: sourceId,
    targetX: x,
    targetY: y,
    hqOf: s.hqOf,
    alivePlayerIds: ALIVE,
  });
}

describe('hostile intersections', () => {
  it('cuts the crossed enemy edge', () => {
    const { s, a, b, attackerSrc } = bridgeSetup();
    const report = attack(s, attackerSrc.id, 400, 20);

    expect(report.ok).toBe(true);
    expect(report.cuts).toHaveLength(1);
    expect(report.cuts[0].victimId).toBe('p2');
    expect(report.cuts[0].x).toBeCloseTo(400);
    expect(report.cuts[0].y).toBeCloseTo(100);
    expect(edgeBetween(s.world, a.id, b.id)).toBeUndefined();
  });

  it('captures the component that loses its route to the victim HQ', () => {
    const { s, victimHq, a, b, c, attackerSrc } = bridgeSetup();
    const report = attack(s, attackerSrc.id, 400, 20);

    expect(report.captures).toHaveLength(1);
    expect(report.captures[0].victimId).toBe('p2');
    expect(report.captures[0].nodeIds).toEqual([b.id, c.id]);

    // Requirement: captured components change ownership.
    expect(s.world.nodes.get(b.id)!.ownerId).toBe('p1');
    expect(s.world.nodes.get(c.id)!.ownerId).toBe('p1');
    expect(edgeBetween(s.world, b.id, c.id)!.ownerId).toBe('p1');

    // The near side stays with the victim.
    expect(s.world.nodes.get(a.id)!.ownerId).toBe('p2');
    expect(s.world.nodes.get(victimHq.id)!.ownerId).toBe('p2');
  });

  it('resets captured node stock to zero', () => {
    const { s, b, c, attackerSrc } = bridgeSetup();
    expect(s.world.nodes.get(b.id)!.stock).toBe(60);
    expect(s.world.nodes.get(c.id)!.stock).toBe(80);

    attack(s, attackerSrc.id, 400, 20);

    expect(s.world.nodes.get(b.id)!.stock).toBe(0);
    expect(s.world.nodes.get(c.id)!.stock).toBe(0);
  });

  it('wires the captured territory into the attacker network through the junction', () => {
    const { s, a, b, attackerSrc } = bridgeSetup();
    attack(s, attackerSrc.id, 400, 20);

    const junction = ownedNodes(s.world, 'p1').find(
      (n) => n.type === 'junction' && Math.abs(n.x - 400) < 1 && Math.abs(n.y - 100) < 1,
    );
    expect(junction).toBeDefined();

    // Captured side hangs off the attacker's junction...
    const link = edgeBetween(s.world, junction!.id, b.id);
    expect(link).toBeDefined();
    expect(link!.ownerId).toBe('p1');
    expect(link!.length).toBeCloseTo(100);

    // ...and the victim's side is NOT reconnected through it.
    expect(edgeBetween(s.world, junction!.id, a.id)).toBeUndefined();
    expect(edgeBetween(s.world, a.id, b.id)).toBeUndefined();
  });

  /**
   * Requirement 4: redundancy. With an alternate route
   * A -- E -- F -- C still joining B to the victim HQ, cutting A--B must
   * capture nothing.
   */
  it('captures nothing when the victim has an alternate route', () => {
    const { s, a, b, c, attackerSrc } = bridgeSetup();
    const e = s.node('p2', 'base', 300, 500, 10);
    const f = s.node('p2', 'base', 700, 500, 10);
    s.link('p2', a, e);
    s.link('p2', e, f);
    s.link('p2', f, c);

    const report = attack(s, attackerSrc.id, 400, 20);

    expect(report.cuts).toHaveLength(1); // the crossed edge is still severed
    expect(report.captures).toHaveLength(0);
    expect(s.world.nodes.get(b.id)!.ownerId).toBe('p2');
    expect(s.world.nodes.get(c.id)!.ownerId).toBe('p2');
    expect(s.world.nodes.get(b.id)!.stock).toBe(60); // untouched
    expect(edgeBetween(s.world, a.id, b.id)).toBeUndefined();
  });

  it('keeps the victim HQ itself out of capture', () => {
    const { s, victimHq, attackerSrc } = bridgeSetup();
    attack(s, attackerSrc.id, 400, 20);
    const hq = s.world.nodes.get(victimHq.id)!;
    expect(hq.ownerId).toBe('p2');
    expect(hq.type).toBe('hq');
  });

  /**
   * Requirement 7: one construction crossing several edges resolves in order
   * from source to destination, deterministically.
   */
  describe('multiple crossings', () => {
    function multiSetup() {
      const s = scenario();
      s.node('p1', 'hq', 60, 400, 500);
      const src = s.node('p1', 'base', 100, 400, 300);

      // Three edges cross the new line at x = 300 (enemy), 500 (own), 700
      // (enemy). Both enemy branches hang off the enemy HQ independently, so
      // each cut isolates exactly one base.
      const p2hq = s.node('p2', 'hq', 300, 40, 300);
      const p2b = s.node('p2', 'base', 300, 760, 30);
      s.link('p2', p2hq, p2b);

      const f1 = s.node('p1', 'base', 500, 250, 20);
      const f2 = s.node('p1', 'base', 500, 550, 20);
      s.link('p1', f1, f2);

      const p2c = s.node('p2', 'base', 700, 250, 30);
      const p2d = s.node('p2', 'base', 700, 550, 30);
      s.link('p2', p2hq, p2c); // stays above the new line, never crossed
      s.link('p2', p2c, p2d);

      return { s, src, p2b, p2d };
    }

    it('produces junctions ordered along the new line', () => {
      const { s, src } = multiSetup();
      const report = completeLine(s.world, {
        ownerId: 'p1',
        sourceNodeId: src.id,
        targetX: 800,
        targetY: 400,
        hqOf: s.hqOf,
        alivePlayerIds: ALIVE,
      });

      expect(report.ok).toBe(true);
      const junctionXs = report.createdNodeIds
        .map((id) => s.world.nodes.get(id))
        .filter((n): n is NonNullable<typeof n> => Boolean(n) && n!.type === 'junction')
        .map((n) => Math.round(n.x));
      expect(junctionXs).toEqual([300, 500, 700]);
      expect(report.cuts.map((c) => Math.round(c.x))).toEqual([300, 700]);
    });

    it('is deterministic across identical runs', () => {
      const runs = [0, 1].map(() => {
        const { s, src } = multiSetup();
        const report = completeLine(s.world, {
          ownerId: 'p1',
          sourceNodeId: src.id,
          targetX: 800,
          targetY: 400,
          hqOf: s.hqOf,
          alivePlayerIds: ALIVE,
        });
        return JSON.stringify({
          report,
          nodes: [...s.world.nodes.values()],
          edges: [...s.world.edges.values()],
        });
      });
      expect(runs[0]).toBe(runs[1]);
    });

    it('treats the builder as the attacker for every hostile crossing', () => {
      const { s, src, p2b, p2d } = multiSetup();
      const report = completeLine(s.world, {
        ownerId: 'p1',
        sourceNodeId: src.id,
        targetX: 800,
        targetY: 400,
        hqOf: s.hqOf,
        alivePlayerIds: ALIVE,
      });
      for (const cut of report.cuts) expect(cut.victimId).toBe('p2');
      // Cutting the HQ-to-base line isolates that base, which p1 takes.
      const captured = report.captures.flatMap((c) => c.nodeIds);
      expect(captured).toEqual([p2b.id, p2d.id]);
      for (const id of captured) expect(s.world.nodes.get(id)!.ownerId).toBe('p1');
    });
  });
});
