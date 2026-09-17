/**
 * Robust-enough 2D segment geometry for the logistics graph.
 *
 * Everything here is pure and side-effect free so it can be unit tested in
 * isolation. The graph, not the rendering, is authoritative game state; these
 * helpers only decide *where* graph surgery happens.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** Parameter-space epsilon used to reject endpoint-touching "intersections". */
export const PARAM_EPS = 1e-9;
/** Denominator epsilon: below this the segments are treated as parallel. */
export const DENOM_EPS = 1e-12;

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function distanceSq(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

export interface SegmentIntersection {
  point: Vec2;
  /** Parameter along the first segment, in (0, 1). */
  t: number;
  /** Parameter along the second segment, in (0, 1). */
  u: number;
}

/**
 * Proper intersection of segments p1->p2 and p3->p4.
 *
 * Returns null for parallel/collinear segments and for touches at (or within
 * epsilon of) an endpoint of either segment. Endpoint touches are deliberately
 * not intersections: two supply lines sharing a node already meet in the graph,
 * so there is nothing to split.
 */
export function segmentIntersection(
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  p4: Vec2,
): SegmentIntersection | null {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = p4.x - p3.x;
  const sy = p4.y - p3.y;

  const denom = cross(rx, ry, sx, sy);
  if (Math.abs(denom) < DENOM_EPS) return null; // parallel or collinear

  const qpx = p3.x - p1.x;
  const qpy = p3.y - p1.y;

  const t = cross(qpx, qpy, sx, sy) / denom;
  const u = cross(qpx, qpy, rx, ry) / denom;

  if (t <= PARAM_EPS || t >= 1 - PARAM_EPS) return null;
  if (u <= PARAM_EPS || u >= 1 - PARAM_EPS) return null;

  return {
    point: { x: p1.x + t * rx, y: p1.y + t * ry },
    t,
    u,
  };
}

/** Shortest distance from point p to segment a->b. */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < DENOM_EPS) return distance(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
