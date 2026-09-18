import { SPAWN_MARGIN, WORLD_HEIGHT, WORLD_WIDTH } from '../shared/config';

export interface SpawnPoint {
  x: number;
  y: number;
}

/**
 * The vertices of a regular n-gon, centred on the map and grown as large as
 * the world will allow.
 *
 * Regular matters for fairness: on the ellipse this replaces, a 3-player match
 * put two players 576 apart and the third 979 away from them, so the opening
 * was decided by which corner you happened to get. Every vertex of a regular
 * polygon is the same distance from its neighbours, so no seat is better.
 *
 * The radius is the largest that keeps every vertex inside the margin rather
 * than a fixed fraction of the map, so a 2-player game stretches across the
 * full width instead of being squeezed into a circle sized by the shorter
 * axis.
 */
export function polygonSpawnPoints(count: number): SpawnPoint[] {
  const cx = WORLD_WIDTH / 2;
  const cy = WORLD_HEIGHT / 2;
  const halfWidth = cx - SPAWN_MARGIN;
  const halfHeight = cy - SPAWN_MARGIN;

  const angles: number[] = [];
  for (let i = 0; i < count; i++) angles.push((i * 2 * Math.PI) / count);

  let radius = Infinity;
  for (const angle of angles) {
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    if (cos > 1e-9) radius = Math.min(radius, halfWidth / cos);
    if (sin > 1e-9) radius = Math.min(radius, halfHeight / sin);
  }
  if (!Number.isFinite(radius)) radius = Math.min(halfWidth, halfHeight);

  return angles.map((angle) => ({
    x: Math.round(cx + radius * Math.cos(angle)),
    y: Math.round(cy + radius * Math.sin(angle)),
  }));
}

/** Fisher-Yates, with the randomness injected so tests can pin the order. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

/**
 * Seats for a match: the polygon's vertices, drawn at random.
 *
 * Every vertex of a regular polygon is strategically equivalent, so the draw
 * changes where your colour sits, not how good the position is.
 */
export function drawSpawnPoints(count: number, random: () => number): SpawnPoint[] {
  return shuffled(polygonSpawnPoints(count), random);
}
