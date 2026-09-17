import { describe, expect, it } from 'vitest';
import {
  clampCamera,
  createCamera,
  fitScale,
  isFitted,
  maxScale,
  panByScreen,
  screenToWorld,
  startingCamera,
  startingScale,
  worldToScreen,
  zoomAt,
  type Viewport,
} from '../src/client/camera';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../src/shared/config';

const desktop: Viewport = { width: 1600, height: 900 };
const wide: Viewport = { width: 1920, height: 800 };
const phone: Viewport = { width: 390, height: 780 };

describe('camera', () => {
  it('starts showing the whole board, centred', () => {
    for (const view of [desktop, wide, phone]) {
      const camera = createCamera(view);
      expect(camera.x).toBe(WORLD_WIDTH / 2);
      expect(camera.y).toBe(WORLD_HEIGHT / 2);
      expect(camera.scale).toBeCloseTo(fitScale(view), 9);
      expect(isFitted(camera, view)).toBe(true);
    }
  });

  it('fits by the tighter axis', () => {
    expect(fitScale(wide)).toBeCloseTo(800 / WORLD_HEIGHT, 9); // height-limited
    expect(fitScale({ width: 800, height: 900 })).toBeCloseTo(800 / WORLD_WIDTH, 9);
  });

  it('round-trips screen and world coordinates', () => {
    const camera = { x: 700, y: 400, scale: 1.7 };
    for (const point of [{ x: 0, y: 0 }, { x: 123, y: 456 }, { x: 1600, y: 900 }]) {
      const back = screenToWorld(camera, desktop, worldToScreen(camera, desktop, point));
      expect(back.x).toBeCloseTo(point.x, 6);
      expect(back.y).toBeCloseTo(point.y, 6);
    }
  });

  it('refuses to zoom out past the whole board', () => {
    const camera = clampCamera({ x: 800, y: 450, scale: 0.01 }, desktop);
    expect(camera.scale).toBeCloseTo(fitScale(desktop), 9);
  });

  it('caps zooming in', () => {
    const camera = clampCamera({ x: 800, y: 450, scale: 9999 }, desktop);
    expect(camera.scale).toBeCloseTo(maxScale(desktop), 9);
  });

  it('lets a phone zoom far enough in to be playable', () => {
    // Fitted, a 1600px board on a 390px screen is unusable; pinching has to
    // get well past 1:1.
    expect(maxScale(phone) / fitScale(phone)).toBeGreaterThan(4);
  });

  it('never lets the board be dragged off screen', () => {
    const zoomed = clampCamera({ x: 800, y: 450, scale: 2 }, desktop);
    const shoved = panByScreen(zoomed, desktop, 100_000, 100_000);
    const topLeft = screenToWorld(shoved, desktop, { x: 0, y: 0 });
    const bottomRight = screenToWorld(shoved, desktop, {
      x: desktop.width,
      y: desktop.height,
    });
    expect(topLeft.x).toBeGreaterThanOrEqual(-1e-6);
    expect(topLeft.y).toBeGreaterThanOrEqual(-1e-6);
    expect(bottomRight.x).toBeLessThanOrEqual(WORLD_WIDTH + 1e-6);
    expect(bottomRight.y).toBeLessThanOrEqual(WORLD_HEIGHT + 1e-6);
  });

  it('pins a fully visible axis to the centre', () => {
    // Fitted on a wide viewport: the board is letterboxed horizontally, so
    // panning sideways must not move it.
    const camera = createCamera(wide);
    const panned = panByScreen(camera, wide, 500, 500);
    expect(panned.x).toBe(WORLD_WIDTH / 2);
    expect(panned.y).toBe(WORLD_HEIGHT / 2);
  });

  it('keeps the world point under the cursor fixed while zooming', () => {
    const view = desktop;
    let camera = createCamera(view);
    const anchor = { x: 300, y: 200 };
    const before = screenToWorld(camera, view, anchor);

    camera = zoomAt(camera, view, anchor, 2.5);
    const after = screenToWorld(camera, view, anchor);

    expect(camera.scale).toBeGreaterThan(fitScale(view));
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
  });

  /**
   * Anchoring can only hold on an axis that is actually pannable. On a tall
   * phone the board never fills the height, so that axis stays centred by
   * design and the pinch anchor applies horizontally only.
   */
  it('anchors on the pannable axis and keeps the other centred', () => {
    let camera = createCamera(phone);
    const anchor = { x: 90, y: 400 };
    const before = screenToWorld(camera, phone, anchor);

    camera = zoomAt(camera, phone, anchor, 3);
    const after = screenToWorld(camera, phone, anchor);

    expect(after.x).toBeCloseTo(before.x, 3); // width is the constrained axis
    expect(camera.y).toBe(WORLD_HEIGHT / 2); // height still fits, so pinned
  });

  it('drags the world with the pointer one-for-one at any zoom', () => {
    const view = desktop;
    const camera = clampCamera({ x: 800, y: 450, scale: 2 }, view);
    const grabbed = screenToWorld(camera, view, { x: 400, y: 300 });
    const panned = panByScreen(camera, view, 60, -40);
    const nowUnder = screenToWorld(panned, view, { x: 460, y: 260 });
    expect(nowUnder.x).toBeCloseTo(grabbed.x, 6);
    expect(nowUnder.y).toBeCloseTo(grabbed.y, 6);
  });

  it('survives a zero-sized viewport without producing NaN', () => {
    const camera = createCamera({ width: 0, height: 0 });
    expect(Number.isFinite(camera.x)).toBe(true);
    expect(Number.isFinite(camera.y)).toBe(true);
    expect(Number.isFinite(camera.scale)).toBe(true);
  });
});

describe('opening camera', () => {
  it('opens fitted on viewports at least as wide as the board', () => {
    for (const view of [desktop, wide, { width: 1280, height: 720 }]) {
      expect(startingScale(view)).toBeCloseTo(fitScale(view), 9);
    }
  });

  it('opens closer in on a portrait phone, where a fit would be unreadable', () => {
    const start = startingScale(phone);
    expect(start).toBeGreaterThan(fitScale(phone) * 1.5);
    expect(start).toBeLessThanOrEqual(maxScale(phone));
  });

  it('frames the requested point and stays inside the world', () => {
    const camera = startingCamera(phone, { x: 1424, y: 450 });
    const right = screenToWorld(camera, phone, { x: phone.width, y: phone.height });
    expect(right.x).toBeLessThanOrEqual(WORLD_WIDTH + 1e-6);
    expect(camera.x).toBeGreaterThan(WORLD_WIDTH / 2); // leaned towards the HQ
  });

  it('falls back to the board centre with no focus point', () => {
    const camera = startingCamera(desktop, null);
    expect(camera.x).toBe(WORLD_WIDTH / 2);
    expect(camera.y).toBe(WORLD_HEIGHT / 2);
  });
});
