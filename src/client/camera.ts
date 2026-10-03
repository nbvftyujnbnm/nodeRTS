import {
  MAX_ZOOM,
  MIN_ZOOM,
  SPAWN_AREA_HEIGHT,
  SPAWN_AREA_WIDTH,
} from '../shared/config';

/** What the camera is looking at: a world point, and screen px per world px. */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/** Drawing surface size in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The region the opening camera frames. Not a boundary. */
export const SPAWN_AREA: Bounds = {
  minX: 0,
  minY: 0,
  maxX: SPAWN_AREA_WIDTH,
  maxY: SPAWN_AREA_HEIGHT,
};

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Scale at which `bounds` just fits the viewport, with a little breathing room. */
export function scaleToFit(bounds: Bounds, view: Viewport, padding = 70): number {
  if (view.width <= 0 || view.height <= 0) return 1;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const usableWidth = Math.max(1, view.width - padding * 2);
  const usableHeight = Math.max(1, view.height - padding * 2);
  return Math.min(usableWidth / width, usableHeight / height);
}

/**
 * The board is infinite, so there is nothing to clamp the camera's position
 * against - only the zoom range, and the requirement that the numbers stay
 * finite. Panning off into empty space is allowed; the fit control brings you
 * back to where the game actually is.
 */
export function clampCamera(camera: Camera, _view?: Viewport): Camera {
  return {
    x: Number.isFinite(camera.x) ? camera.x : SPAWN_AREA_WIDTH / 2,
    y: Number.isFinite(camera.y) ? camera.y : SPAWN_AREA_HEIGHT / 2,
    scale: Number.isFinite(camera.scale) ? clamp(camera.scale, MIN_ZOOM, MAX_ZOOM) : 1,
  };
}

/** A camera framing an arbitrary region. */
export function fitBounds(bounds: Bounds, view: Viewport, padding = 70): Camera {
  return clampCamera({
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    scale: scaleToFit(bounds, view, padding),
  });
}

/** Bounding box of some points, or null when there are none. */
export function boundsOfPoints(points: Iterable<Point>): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

/** Grow a box on all sides, so a fit does not put nodes right on the edge. */
export function padBounds(bounds: Bounds, margin: number): Bounds {
  return {
    minX: bounds.minX - margin,
    minY: bounds.minY - margin,
    maxX: bounds.maxX + margin,
    maxY: bounds.maxY + margin,
  };
}

export function createCamera(view: Viewport): Camera {
  return fitBounds(SPAWN_AREA, view);
}

export function worldToScreen(camera: Camera, view: Viewport, world: Point): Point {
  return {
    x: (world.x - camera.x) * camera.scale + view.width / 2,
    y: (world.y - camera.y) * camera.scale + view.height / 2,
  };
}

export function screenToWorld(camera: Camera, view: Viewport, screen: Point): Point {
  return {
    x: (screen.x - view.width / 2) / camera.scale + camera.x,
    y: (screen.y - view.height / 2) / camera.scale + camera.y,
  };
}

/** The world rectangle currently on screen. */
export function visibleBounds(camera: Camera, view: Viewport): Bounds {
  const topLeft = screenToWorld(camera, view, { x: 0, y: 0 });
  const bottomRight = screenToWorld(camera, view, { x: view.width, y: view.height });
  return {
    minX: topLeft.x,
    minY: topLeft.y,
    maxX: bottomRight.x,
    maxY: bottomRight.y,
  };
}

/**
 * Zoom by `factor` while keeping the world point under `anchor` (a screen
 * position: the cursor, or the midpoint between two fingers) in place.
 *
 * With no bounds to fight, this holds exactly on both axes, right up to the
 * zoom limits.
 */
export function zoomAt(camera: Camera, view: Viewport, anchor: Point, factor: number): Camera {
  const before = screenToWorld(camera, view, anchor);
  const scaled = clampCamera({ ...camera, scale: camera.scale * factor });
  const after = screenToWorld(scaled, view, anchor);
  return clampCamera({
    x: scaled.x + (before.x - after.x),
    y: scaled.y + (before.y - after.y),
    scale: scaled.scale,
  });
}

/** Drag the world with the pointer: the same world point stays under it. */
export function panByScreen(camera: Camera, _view: Viewport, dx: number, dy: number): Camera {
  return clampCamera({
    x: camera.x - dx / camera.scale,
    y: camera.y - dy / camera.scale,
    scale: camera.scale,
  });
}

/** Never start more than this much closer than a plain fit. */
const MAX_START_FILL = 2.5;

/**
 * Scale to open a match at.
 *
 * Framing the spawn area on a tall phone leaves most of the screen empty and
 * the pieces too small to read, so portrait viewports start closer in - the
 * player pans, and the fit button is one tap away. Viewports at least as wide
 * as the spawn area are unaffected.
 */
export function startingScale(view: Viewport): number {
  const fit = scaleToFit(SPAWN_AREA, view);
  const areaAspect = SPAWN_AREA_WIDTH / SPAWN_AREA_HEIGHT;
  const viewAspect = view.width / view.height;
  if (!Number.isFinite(viewAspect) || viewAspect <= 0 || viewAspect >= areaAspect) return fit;
  const fill = Math.min(areaAspect / viewAspect, MAX_START_FILL);
  return clamp(fit * fill, MIN_ZOOM, MAX_ZOOM);
}

/** Opening camera, looking at `focus` (normally the player's own HQ). */
export function startingCamera(view: Viewport, focus: Point | null): Camera {
  return clampCamera({
    x: focus?.x ?? SPAWN_AREA_WIDTH / 2,
    y: focus?.y ?? SPAWN_AREA_HEIGHT / 2,
    scale: startingScale(view),
  });
}

export function isZoomedOutFully(camera: Camera): boolean {
  return camera.scale <= MIN_ZOOM + 1e-9;
}
