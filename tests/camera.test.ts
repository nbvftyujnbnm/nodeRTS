import { describe, expect, it } from 'vitest';
import {
  boundsOfPoints,
  clampCamera,
  createCamera,
  fitBounds,
  isZoomedOutFully,
  padBounds,
  panByScreen,
  scaleToFit,
  screenToWorld,
  startingCamera,
  startingScale,
  visibleBounds,
  worldToScreen,
  zoomAt,
  SPAWN_AREA,
  type Viewport,
} from '../src/client/camera';
import { gridSpacing } from '../src/client/render';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  SPAWN_AREA_HEIGHT,
  SPAWN_AREA_WIDTH,
} from '../src/shared/config';

const desktop: Viewport = { width: 1600, height: 900 };
const wide: Viewport = { width: 1920, height: 800 };
const phone: Viewport = { width: 390, height: 780 };

describe('camera', () => {
  it('starts framing the spawn area, centred', () => {
    for (const view of [desktop, wide, phone]) {
      const camera = createCamera(view);
      expect(camera.x).toBe(SPAWN_AREA_WIDTH / 2);
      expect(camera.y).toBe(SPAWN_AREA_HEIGHT / 2);
      expect(camera.scale).toBeCloseTo(scaleToFit(SPAWN_AREA, view), 9);
    }
  });

  it('round-trips screen and world coordinates', () => {
    const camera = { x: 700, y: 400, scale: 1.7 };
    for (const point of [{ x: 0, y: 0 }, { x: 123, y: 456 }, { x: -9000, y: 24000 }]) {
      const back = screenToWorld(camera, desktop, worldToScreen(camera, desktop, point));
      expect(back.x).toBeCloseTo(point.x, 6);
      expect(back.y).toBeCloseTo(point.y, 6);
    }
  });

  /**
   * The point of an infinite canvas: nothing fences the view in. What used to
   * be clamped to a 1600x900 board now simply keeps going.
   */
  it('pans without limit in every direction', () => {
    let camera = clampCamera({ x: 800, y: 450, scale: 1 });
    for (let i = 0; i < 50; i++) camera = panByScreen(camera, desktop, -500, -500);
    expect(camera.x).toBeGreaterThan(20_000);
    expect(camera.y).toBeGreaterThan(20_000);

    for (let i = 0; i < 200; i++) camera = panByScreen(camera, desktop, 500, 500);
    expect(camera.x).toBeLessThan(-50_000);
    expect(camera.y).toBeLessThan(-50_000);
  });

  it('keeps panning meaningful at any zoom', () => {
    const camera = clampCamera({ x: 0, y: 0, scale: 0.1 });
    const grabbed = screenToWorld(camera, desktop, { x: 400, y: 300 });
    const panned = panByScreen(camera, desktop, 60, -40);
    const nowUnder = screenToWorld(panned, desktop, { x: 460, y: 260 });
    expect(nowUnder.x).toBeCloseTo(grabbed.x, 6);
    expect(nowUnder.y).toBeCloseTo(grabbed.y, 6);
  });

  it('bounds the zoom range', () => {
    expect(clampCamera({ x: 0, y: 0, scale: 1e-9 }).scale).toBeCloseTo(MIN_ZOOM, 9);
    expect(clampCamera({ x: 0, y: 0, scale: 9999 }).scale).toBeCloseTo(MAX_ZOOM, 9);
    expect(isZoomedOutFully(clampCamera({ x: 0, y: 0, scale: 1e-9 }))).toBe(true);
    expect(isZoomedOutFully(clampCamera({ x: 0, y: 0, scale: 1 }))).toBe(false);
  });

  it('refuses to produce NaN from a broken camera or viewport', () => {
    for (const camera of [
      { x: Number.NaN, y: 0, scale: 1 },
      { x: 0, y: Number.POSITIVE_INFINITY, scale: 1 },
      { x: 0, y: 0, scale: Number.NaN },
    ]) {
      const safe = clampCamera(camera);
      expect(Number.isFinite(safe.x)).toBe(true);
      expect(Number.isFinite(safe.y)).toBe(true);
      expect(Number.isFinite(safe.scale)).toBe(true);
    }
    const zero = createCamera({ width: 0, height: 0 });
    expect(Number.isFinite(zero.scale)).toBe(true);
  });

  /** No bounds to fight means the anchor holds on both axes, everywhere. */
  it('keeps the world point under the cursor fixed while zooming', () => {
    for (const view of [desktop, phone]) {
      for (const anchor of [{ x: 10, y: 10 }, { x: view.width - 5, y: view.height - 5 }]) {
        let camera = createCamera(view);
        const before = screenToWorld(camera, view, anchor);
        camera = zoomAt(camera, view, anchor, 2.5);
        const after = screenToWorld(camera, view, anchor);
        expect(after.x).toBeCloseTo(before.x, 4);
        expect(after.y).toBeCloseTo(before.y, 4);
      }
    }
  });

  it('holds the anchor far away from the origin too', () => {
    let camera = clampCamera({ x: 48_000, y: -31_000, scale: 0.4 });
    const anchor = { x: 120, y: 640 };
    const before = screenToWorld(camera, desktop, anchor);
    camera = zoomAt(camera, desktop, anchor, 0.3);
    const after = screenToWorld(camera, desktop, anchor);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
  });
});

describe('fitting content', () => {
  it('frames an arbitrary box, wherever it is', () => {
    const bounds = { minX: 12_000, minY: -4_000, maxX: 14_000, maxY: -3_000 };
    const camera = fitBounds(bounds, desktop);
    expect(camera.x).toBeCloseTo(13_000, 6);
    expect(camera.y).toBeCloseTo(-3_500, 6);

    const visible = visibleBounds(camera, desktop);
    expect(visible.minX).toBeLessThanOrEqual(bounds.minX);
    expect(visible.maxX).toBeGreaterThanOrEqual(bounds.maxX);
    expect(visible.minY).toBeLessThanOrEqual(bounds.minY);
    expect(visible.maxY).toBeGreaterThanOrEqual(bounds.maxY);
  });

  it('measures the box around a scattered network', () => {
    const bounds = boundsOfPoints([
      { x: 100, y: 200 },
      { x: -5_000, y: 90 },
      { x: 3_000, y: 12_000 },
    ]);
    expect(bounds).toEqual({ minX: -5_000, minY: 90, maxX: 3_000, maxY: 12_000 });
    expect(boundsOfPoints([])).toBeNull();
    expect(boundsOfPoints([{ x: Number.NaN, y: 0 }])).toBeNull();
  });

  it('pads a box on every side', () => {
    expect(padBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 5)).toEqual({
      minX: -5, minY: -5, maxX: 15, maxY: 15,
    });
  });

  it('never fits beyond the zoom limits', () => {
    const vast = { minX: -400_000, minY: -400_000, maxX: 400_000, maxY: 400_000 };
    expect(fitBounds(vast, desktop).scale).toBeCloseTo(MIN_ZOOM, 9);
    const tiny = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    expect(fitBounds(tiny, desktop).scale).toBeCloseTo(MAX_ZOOM, 9);
  });
});

describe('opening camera', () => {
  it('frames the spawn area on viewports at least as wide as it is', () => {
    for (const view of [desktop, wide, { width: 1280, height: 720 }]) {
      expect(startingScale(view)).toBeCloseTo(scaleToFit(SPAWN_AREA, view), 9);
    }
  });

  it('opens closer in on a portrait phone, where a fit would be unreadable', () => {
    expect(startingScale(phone)).toBeGreaterThan(scaleToFit(SPAWN_AREA, phone) * 1.5);
    expect(startingScale(phone)).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it('frames the requested point', () => {
    const camera = startingCamera(phone, { x: 1520, y: 450 });
    expect(camera.x).toBe(1520);
    expect(camera.y).toBe(450);
  });

  it('falls back to the spawn area centre with no focus point', () => {
    const camera = startingCamera(desktop, null);
    expect(camera.x).toBe(SPAWN_AREA_WIDTH / 2);
    expect(camera.y).toBe(SPAWN_AREA_HEIGHT / 2);
  });
});

describe('infinite grid', () => {
  it('keeps grid lines at a readable spacing at every zoom', () => {
    for (let scale = MIN_ZOOM; scale <= MAX_ZOOM; scale *= 1.3) {
      const spacing = gridSpacing(scale);
      const onScreen = spacing * scale;
      // Never a dense haze, never a near-empty screen. Picking the nearest
      // 1-2-5 step keeps this inside sqrt(2.5) of the 110px target.
      expect(onScreen).toBeGreaterThan(65);
      expect(onScreen).toBeLessThan(180);
    }
  });

  it('steps through round numbers', () => {
    for (let scale = MIN_ZOOM; scale <= MAX_ZOOM; scale *= 1.17) {
      const spacing = gridSpacing(scale);
      const mantissa = spacing / Math.pow(10, Math.floor(Math.log10(spacing)));
      expect([1, 2, 5, 10]).toContain(Math.round(mantissa));
    }
  });
});
