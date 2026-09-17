import { describe, expect, it } from 'vitest';
import { GameRoom } from '../src/game/room';
import {
  BASE_MAX_STOCK,
  BUILD_REQUEST_MIN_INTERVAL_MS,
  HQ_ASSAULT_COST_MULTIPLIER,
  HQ_ASSAULT_MAX_RANGE,
  MAX_BUILD_DISTANCE,
  MIN_BUILD_DISTANCE,
  TICK_INTERVAL_MS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  buildCostForDistance,
} from '../src/shared/config';
import { addEdge, addNode, findHq } from '../src/game/world';

/**
 * Plays the degenerate strategy: sprint a single chain of relays straight at
 * the enemy HQ and take it, ignoring economy and territory entirely.
 *
 * Returns how many seconds of simulated time the rush needed to win, or null
 * if it never got there. This is the number that decides whether the game is
 * about logistics or about who clicks a straight line first.
 */
function simulateRush(
  maxSeconds = 300,
  onTick?: (room: GameRoom, now: number, ids: { attacker: string; victim: string }) => void,
): { seconds: number | null; relays: number; room: GameRoom } {
  const room = new GameRoom({ code: 'RUSH' });
  const attacker = room.addPlayer('Rusher', 's1', 0);
  const victim = room.addPlayer('Victim', 's2', 0);
  if ('error' in attacker || 'error' in victim) throw new Error('setup failed');
  room.start(0);

  const enemyHq = findHq(room.world, victim.id)!;
  let now = 0;
  let relays = 0;
  let nextAttemptAt = 0;

  while (now < maxSeconds * 1000) {
    now += TICK_INTERVAL_MS;
    room.tick(now);
    onTick?.(room, now, { attacker: attacker.id, victim: victim.id });
    if (room.status === 'finished') {
      return { seconds: now / 1000, relays, room };
    }
    if (room.constructions.size > 0) continue; // one chain, one build at a time
    // Respect the server's build rate limit; retrying faster only re-arms it.
    if (now < nextAttemptAt) continue;
    nextAttemptAt = now + BUILD_REQUEST_MIN_INTERVAL_MS + TICK_INTERVAL_MS;

    // Push from whichever owned node is closest to the enemy HQ.
    let front = null as null | { id: string; x: number; y: number; stock: number };
    let bestDist = Infinity;
    for (const node of room.world.nodes.values()) {
      if (node.ownerId !== attacker.id) continue;
      const d = Math.hypot(enemyHq.x - node.x, enemyHq.y - node.y);
      if (d < bestDist) {
        bestDist = d;
        front = node;
      }
    }
    if (!front) break;
    if (Math.hypot(enemyHq.x - front.x, enemyHq.y - front.y) < 1) break;

    const dx = enemyHq.x - front.x;
    const dy = enemyHq.y - front.y;
    const len = Math.hypot(dx, dy) || 1;

    // A competent rusher, not a naive one: close to assault range, then strike.
    // Relays deliberately stop short of the HQ so they land as a normal base
    // and leave a legal assault distance for the next build.
    const standOff = (HQ_ASSAULT_MAX_RANGE + MIN_BUILD_DISTANCE) / 2;
    const assaulting = len <= HQ_ASSAULT_MAX_RANGE;
    const reach = assaulting ? len : Math.min(MAX_BUILD_DISTANCE, len - standOff);

    const targetX = Math.max(0, Math.min(WORLD_WIDTH, front.x + (dx / len) * reach));
    const targetY = Math.max(0, Math.min(WORLD_HEIGHT, front.y + (dy / len) * reach));

    const result = room.requestBuild(attacker.id, front.id, targetX, targetY, now);
    if (result.ok && !assaulting) relays++;
  }
  return { seconds: null, relays, room };
}

describe('rush balance', () => {
  /**
   * The whole design rests on supply networks being cuttable. A rush that lands
   * before the defender can plausibly see it and build one crossing line makes
   * every other mechanic decorative.
   *
   * Reacting costs the defender a build of their own: roughly a node refill
   * plus construction, ~7s, and they have to notice first. Anything under about
   * 20s is not a game.
   */
  it('cannot win a 2-player match faster than a defender could respond', () => {
    const { seconds, relays } = simulateRush();
    expect(seconds).not.toBeNull();
    console.log(`  rush wins in ${seconds?.toFixed(1)}s using ${relays} relay(s)`);
    expect(seconds!).toBeGreaterThan(20);
  });

  it('forces the rush to commit to a long, cuttable chain', () => {
    const { relays } = simulateRush();
    expect(relays).toBeGreaterThanOrEqual(3);
  });

  /**
   * The assault multipliers must never price a headquarters out of reach, or
   * a match could only ever end by disconnection.
   */
  it('always leaves a maximum-range assault affordable from a full base', () => {
    const worstCase = buildCostForDistance(HQ_ASSAULT_MAX_RANGE) * HQ_ASSAULT_COST_MULTIPLIER;
    expect(worstCase).toBeLessThanOrEqual(BASE_MAX_STOCK);
  });

  /**
   * The point of slowing the rush down is that the core mechanic gets a chance
   * to answer it. A defender who spots the chain and puts one line across it
   * takes everything past the cut, including the node the assault was being
   * launched from.
   */
  it('lets a defender answer the rush by cutting the chain', () => {
    let cut = false;
    const { room } = simulateRush(20, (r, now, ids) => {
      if (cut || now < 15_000) return;
      cut = true;
      // The defender has expanded off-axis by now; stage that, then cross the
      // attacker's chain with a real, fully validated build.
      const hq = findHq(r.world, ids.victim)!;
      const staging = addNode(r.world, ids.victim, 'base', 500, 250, BASE_MAX_STOCK);
      addEdge(r.world, ids.victim, hq.id, staging.id);
      const result = r.requestBuild(ids.victim, staging.id, 500, 650, now);
      expect(result.ok).toBe(true);
    });

    expect(cut).toBe(true);
    const events = room.drainEvents();
    const capture = events.find((e) => e.type === 'networkCaptured');
    expect(capture, 'the cut should isolate part of the rush chain').toBeDefined();
    if (capture && capture.type === 'networkCaptured') {
      expect(capture.nodeIds.length).toBeGreaterThan(0);
    }
    expect(events.some((e) => e.type === 'supplyLineCut')).toBe(true);
    // And the rush did not land in the meantime.
    expect(room.status).toBe('playing');
  });

  it('puts the two headquarters on the long axis of the map', () => {
    const room = new GameRoom({ code: 'SPAN' });
    room.addPlayer('a', 's1', 0);
    room.addPlayer('b', 's2', 0);
    room.start(0);
    const [a, b] = [...room.world.nodes.values()].filter((n) => n.type === 'hq');
    const span = Math.hypot(a.x - b.x, a.y - b.y);
    // The short axis would be ~666, which is what made the two-build rush work.
    expect(span).toBeGreaterThan(1000);
  });
});
