import { describe, expect, it } from 'vitest';
import { drawSpawnPoints, polygonSpawnPoints, shuffled } from '../src/game/spawn';
import { GameRoom } from '../src/game/room';
import { MAX_PLAYERS, SPAWN_MARGIN, WORLD_HEIGHT, WORLD_WIDTH } from '../src/shared/config';

function sideLengths(points: { x: number; y: number }[]): number[] {
  return points.map((p, i) => {
    const next = points[(i + 1) % points.length];
    return Math.hypot(p.x - next.x, p.y - next.y);
  });
}

describe('spawn layout', () => {
  it('places every player on the vertices of a regular polygon', () => {
    for (let count = 3; count <= MAX_PLAYERS; count++) {
      const points = polygonSpawnPoints(count);
      expect(points).toHaveLength(count);
      const sides = sideLengths(points);
      // Regular means every edge of the polygon is the same length. The
      // ellipse this replaced was not: a 3-player match put two players 576
      // apart and the third 979 away, so the seat you got decided the opening.
      // Vertices are rounded to whole pixels, so allow a couple of px of slack.
      const spread = Math.max(...sides) - Math.min(...sides);
      expect(spread, `${count} players: sides ${sides.map((v) => v.toFixed(1))}`).toBeLessThan(2);
    }
  });

  it('keeps every spawn inside the world, clear of the edge', () => {
    for (let count = 2; count <= MAX_PLAYERS; count++) {
      for (const point of polygonSpawnPoints(count)) {
        expect(point.x).toBeGreaterThanOrEqual(SPAWN_MARGIN - 1);
        expect(point.x).toBeLessThanOrEqual(WORLD_WIDTH - SPAWN_MARGIN + 1);
        expect(point.y).toBeGreaterThanOrEqual(SPAWN_MARGIN - 1);
        expect(point.y).toBeLessThanOrEqual(WORLD_HEIGHT - SPAWN_MARGIN + 1);
      }
    }
  });

  it('grows the polygon to the largest the map allows', () => {
    // At least one vertex has to be pressed right up against the margin,
    // otherwise the polygon could still have been bigger.
    for (let count = 2; count <= MAX_PLAYERS; count++) {
      const points = polygonSpawnPoints(count);
      const touchesEdge = points.some(
        (p) =>
          Math.abs(p.x - SPAWN_MARGIN) <= 1 ||
          Math.abs(p.x - (WORLD_WIDTH - SPAWN_MARGIN)) <= 1 ||
          Math.abs(p.y - SPAWN_MARGIN) <= 1 ||
          Math.abs(p.y - (WORLD_HEIGHT - SPAWN_MARGIN)) <= 1,
      );
      expect(touchesEdge, `${count} players`).toBe(true);
    }
  });

  it('spreads a 2-player match across the long axis', () => {
    const [a, b] = polygonSpawnPoints(2);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(1300);
    expect(a.y).toBe(b.y); // horizontal, not squeezed onto the short axis
  });

  it('draws the seats at random without losing or duplicating any', () => {
    const points = polygonSpawnPoints(5);
    const drawn = drawSpawnPoints(5, () => 0.42);
    expect(drawn).toHaveLength(5);
    const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    expect(new Set(drawn.map(key))).toEqual(new Set(points.map(key)));
  });

  it('actually varies the draw across matches', () => {
    const orders = new Set<string>();
    for (let i = 0; i < 200; i++) {
      orders.add(drawSpawnPoints(4, Math.random).map((p) => `${p.x},${p.y}`).join('|'));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('shuffles without dropping elements, even with a degenerate rng', () => {
    for (const rng of [() => 0, () => 0.999999, () => 1, Math.random]) {
      const out = shuffled([1, 2, 3, 4, 5], rng);
      expect([...out].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('gives a started room one HQ per player on those vertices', () => {
    const room = new GameRoom({ code: 'SPWN', random: () => 0.7 });
    for (let i = 0; i < 4; i++) room.addPlayer(`p${i}`, `s${i}`, 0);
    room.start(0);

    const hqs = [...room.world.nodes.values()].filter((n) => n.type === 'hq');
    expect(hqs).toHaveLength(4);
    const expected = new Set(polygonSpawnPoints(4).map((p) => `${p.x},${p.y}`));
    for (const hq of hqs) expect(expected.has(`${hq.x},${hq.y}`)).toBe(true);
    expect(new Set(hqs.map((h) => `${h.x},${h.y}`)).size).toBe(4);
  });
});
