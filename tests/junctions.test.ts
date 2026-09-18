import { describe, expect, it } from 'vitest';
import { completeLine } from '../src/game/lines';
import { resolveBuildTarget } from '../src/game/target';
import { simulateSupply } from '../src/game/supply';
import { shortestDistances } from '../src/game/graph';
import { addEdge, addNode, createWorld, findHq, type World } from '../src/game/world';
import {
  BASE_MAX_STOCK,
  HQ_PRODUCTION_PER_SECOND,
  NODE_PRODUCTION_PER_SECOND,
  capacityForNodeType,
} from '../src/shared/config';
import { hqNode, startedRoom, towardCentre } from './helpers';

const ALIVE = new Set(['p1']);

/** One tick with everything full, so all income stays at the HQ and is readable. */
function incomeOf(world: World, ownerId: string): number {
  const hq = findHq(world, ownerId)!;
  hq.stock = 0;
  for (const node of world.nodes.values()) {
    if (node.ownerId === ownerId && node.type !== 'hq') node.stock = capacityForNodeType(node.type);
  }
  simulateSupply(world, [{ id: ownerId, alive: true }], 1);
  return hq.stock;
}

/**
 * A fan of five lines from the HQ, plus a loose node positioned so that one
 * build crossing the whole fan mints five junctions at once. This is the shape
 * that turned free crossings into free economy.
 */
function fanSetup() {
  const world = createWorld();
  const hq = addNode(world, 'p1', 'hq', 200, 450, 0);
  for (const y of [200, 325, 450, 575, 700]) {
    const tip = addNode(world, 'p1', 'base', 900, y, 0);
    addEdge(world, 'p1', hq.id, tip.id);
  }
  // Deliberately unconnected: the crossing line is what will wire it in.
  const source = addNode(world, 'p1', 'base', 700, 60, 0);
  return { world, hq, source };
}

function crossTheFan(world: World, sourceId: string) {
  return completeLine(world, {
    ownerId: 'p1',
    sourceNodeId: sourceId,
    targetX: 700,
    targetY: 820,
    hqOf: (id) => findHq(world, id)?.id ?? null,
    alivePlayerIds: ALIVE,
  });
}

describe('junctions are wiring, not territory', () => {
  it('hold nothing', () => {
    expect(capacityForNodeType('junction')).toBe(0);
  });

  it('never accumulate stock even when fully supplied', () => {
    const { world, source } = fanSetup();
    const report = crossTheFan(world, source.id);
    expect(report.ok).toBe(true);

    const hq = findHq(world, 'p1')!;
    hq.stock = 500;
    for (let i = 0; i < 40; i++) simulateSupply(world, [{ id: 'p1', alive: true }], 0.25);

    const junctions = [...world.nodes.values()].filter((n) => n.type === 'junction');
    expect(junctions.length).toBeGreaterThan(0);
    for (const junction of junctions) expect(junction.stock).toBe(0);
  });

  /** The exploit this closes: one build across your own fan minted five earners. */
  it('add no income, however many a single build creates', () => {
    const { world, source } = fanSetup();
    const before = incomeOf(world, 'p1');

    const report = crossTheFan(world, source.id);
    const junctions = [...world.nodes.values()].filter((n) => n.type === 'junction');
    expect(junctions.length).toBe(5);

    const after = incomeOf(world, 'p1');

    // The build wired in two bases: the loose source it started from, and the
    // one it ended at. Those are the only new earners.
    const gain = after - before;
    expect(gain).toBeCloseTo(2 * NODE_PRODUCTION_PER_SECOND, 6);

    // Under the old rule the five junctions paid as well, so the same single
    // build would have been worth more than three times as much.
    const oldRuleGain = (2 + junctions.length) * NODE_PRODUCTION_PER_SECOND;
    expect(gain).toBeLessThan(oldRuleGain / 3);
    void report;
  });

  it('income counts supplied bases only', () => {
    const { world, source } = fanSetup();
    crossTheFan(world, source.id);
    const bases = [...world.nodes.values()].filter((n) => n.type === 'base');
    expect(incomeOf(world, 'p1')).toBeCloseTo(
      HQ_PRODUCTION_PER_SECOND + bases.length * NODE_PRODUCTION_PER_SECOND,
      6,
    );
  });

  /** Inert, but still part of the network: supply has to flow through them. */
  it('still conduct supply to what lies beyond them', () => {
    const { world, hq, source } = fanSetup();
    crossTheFan(world, source.id);

    // `source` is reachable only through the junctions the crossing created.
    const distances = shortestDistances(world, 'p1', hq.id);
    expect(distances.has(source.id)).toBe(true);

    source.stock = 0;
    hq.stock = 500;
    for (let i = 0; i < 20; i++) simulateSupply(world, [{ id: 'p1', alive: true }], 0.25);
    expect(source.stock).toBeGreaterThan(10);
    expect(source.stock).toBeLessThanOrEqual(BASE_MAX_STOCK);
  });

  it('cannot start a line, with a reason that says why', () => {
    const { room, ids } = startedRoom(2);
    const hq = hqNode(room, ids[0]);
    const spot = towardCentre(hq, 120);
    const junction = addNode(room.world, ids[0], 'junction', spot.x, spot.y, 0);
    addEdge(room.world, ids[0], hq.id, junction.id);

    const aim = towardCentre(junction, 150);
    const result = room.requestBuild(ids[0], junction.id, aim.x, aim.y, 2_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('junctions only relay - build from a base or HQ');
  });

  it('still lets a base right next to a junction build normally', () => {
    const { room, ids } = startedRoom(2);
    const hq = hqNode(room, ids[0]);
    const spot = towardCentre(hq, 120);
    const junction = addNode(room.world, ids[0], 'junction', spot.x, spot.y, 0);
    addEdge(room.world, ids[0], hq.id, junction.id);

    const aim = towardCentre(hq, 224);
    const result = room.requestBuild(ids[0], hq.id, aim.x, aim.y, 2_000);
    expect(result.ok).toBe(true);
    void junction;
  });
});

describe('junctions are invisible to aiming', () => {
  it('are never snapped onto as a build target', () => {
    const world = createWorld();
    const hq = addNode(world, 'p1', 'hq', 200, 450, 500);
    const junction = addNode(world, 'p1', 'junction', 600, 450, 0);
    const base = addNode(world, 'p1', 'base', 1000, 450, 0);

    // Aim a few pixels from the junction: it must not pull the line in.
    const nearJunction = resolveBuildTarget(
      world.nodes.values(), 'p1', hq.id, junction.x + 4, junction.y + 4, ALIVE,
    );
    expect(nearJunction.kind).toBe('new');
    expect(nearJunction.node).toBeNull();

    // A base at the same offset still snaps, so the rule is specific.
    const nearBase = resolveBuildTarget(
      world.nodes.values(), 'p1', hq.id, base.x + 4, base.y + 4, ALIVE,
    );
    expect(nearBase.kind).toBe('snap');
    expect(nearBase.node?.id).toBe(base.id);
  });
});
