import { WORLD_HEIGHT, WORLD_WIDTH } from '../shared/config';

/** What the camera is looking at: a world point, and how many screen px per world px. */
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

/** Scale at which the whole 1600x900 board just fits the viewport. */
export function fitScale(view: Viewport): number {
  if (view.width <= 0 || view.height <= 0) return 1;
  return Math.min(view.width / WORLD_WIDTH, view.height / WORLD_HEIGHT);
}

/**
 * Zooming out past "everything visible" only adds dead space, so that is the
 * floor. The ceiling is generous on small screens, where the fitted board is
 * tiny and pinching in is the only way to play.
 */
export function maxScale(view: Viewport): number {
  return Math.max(fitScale(view) * 4, 3);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Keep the view inside the world. When an axis is fully visible the camera is
 * pinned to the middle of it, so the board cannot be shoved off screen.
 */
export function clampCamera(camera: Camera, view: Viewport): Camera {
  const scale = clamp(camera.scale, fitScale(view), maxScale(view));
  const halfW = view.width / (2 * scale);
  const halfH = view.height / (2 * scale);

  const x = halfW * 2 >= WORLD_WIDTH ? WORLD_WIDTH / 2 : clamp(camera.x, halfW, WORLD_WIDTH - halfW);
  const y = halfH * 2 >= WORLD_HEIGHT ? WORLD_HEIGHT / 2 : clamp(camera.y, halfH, WORLD_HEIGHT - halfH);

  return { x, y, scale };
}

/** A camera showing the whole board. */
export function createCamera(view: Viewport): Camera {
  return clampCamera({ x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2, scale: fitScale(view) }, view);
}

/** Never start more than this much closer than a plain fit. */
const MAX_START_FILL = 2.5;

/**
 * Scale to open a match at.
 *
 * Fitting a 16:9 board onto a tall phone leaves most of the screen empty and
 * the pieces too small to read, so portrait viewports start closer in - the
 * player pans, and the fit button is one tap away. Viewports at least as wide
 * as the board are unaffected and still start fully fitted.
 */
export function startingScale(view: Viewport): number {
  const fit = fitScale(view);
  const boardAspect = WORLD_WIDTH / WORLD_HEIGHT;
  const viewAspect = view.width / view.height;
  if (!Number.isFinite(viewAspect) || viewAspect <= 0 || viewAspect >= boardAspect) return fit;
  const fill = Math.min(boardAspect / viewAspect, MAX_START_FILL);
  return clamp(fit * fill, fit, maxScale(view));
}

/** Opening camera, looking at `focus` (normally the player's own HQ). */
export function startingCamera(view: Viewport, focus: Point | null): Camera {
  return clampCamera(
    {
      x: focus?.x ?? WORLD_WIDTH / 2,
      y: focus?.y ?? WORLD_HEIGHT / 2,
      scale: startingScale(view),
    },
    view,
  );
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

/**
 * Zoom by `factor` while keeping the world point under `anchor` (a screen
 * position: the cursor, or the midpoint between two fingers) in place.
 */
export function zoomAt(camera: Camera, view: Viewport, anchor: Point, factor: number): Camera {
  const before = screenToWorld(camera, view, anchor);
  const scaled = clampCamera({ ...camera, scale: camera.scale * factor }, view);
  const after = screenToWorld(scaled, view, anchor);
  return clampCamera(
    { x: scaled.x + (before.x - after.x), y: scaled.y + (before.y - after.y), scale: scaled.scale },
    view,
  );
}

/** Drag the world with the pointer: the same world point stays under it. */
export function panByScreen(camera: Camera, view: Viewport, dx: number, dy: number): Camera {
  return clampCamera(
    { x: camera.x - dx / camera.scale, y: camera.y - dy / camera.scale, scale: camera.scale },
    view,
  );
}

/** True when the board is fully visible, i.e. panning would do nothing. */
export function isFitted(camera: Camera, view: Viewport): boolean {
  return camera.scale <= fitScale(view) + 1e-9;
}
