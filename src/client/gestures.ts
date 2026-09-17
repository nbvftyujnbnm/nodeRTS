import {
  panByScreen,
  screenToWorld,
  zoomAt,
  type Camera,
  type Point,
  type Viewport,
} from './camera';

export interface GestureCallbacks {
  getCamera(): Camera;
  setCamera(camera: Camera): void;
  getView(): Viewport;
  /** A node is selected, so a single-pointer drag aims instead of panning. */
  isAiming(): boolean;
  /** Tap with nothing selected: pick a node. */
  onTap(world: Point): void;
  /** Aim moved (or ended, with null) while a node is selected. */
  onAimMove(world: Point | null): void;
  /** Aim released: commit the build. */
  onAimRelease(world: Point): void;
  /** Right click or two-finger tap: drop the selection. */
  onCancel(): void;
  /** Mouse hover only; touch has no hover. */
  onHover(world: Point | null): void;
}

/** How far a pointer may move and still count as a tap, in CSS pixels. */
const TAP_SLOP = 9;

type Mode = 'idle' | 'press' | 'pan' | 'aim' | 'pinch';

/**
 * One pointer-event state machine for mouse, touch and pen.
 *
 * - nothing selected: drag pans, tap selects
 * - node selected: drag aims and shows the preview, release builds
 * - two fingers: pinch to zoom and pan together, at any time
 * - right button: drag pans, click cancels the selection
 */
export function attachGestures(canvas: HTMLCanvasElement, cb: GestureCallbacks): () => void {
  const pointers = new Map<number, Point>();
  let mode: Mode = 'idle';
  let moved = false;
  let rightButton = false;
  let last: Point = { x: 0, y: 0 };
  let pinchDistance = 0;

  const toLocal = (event: PointerEvent): Point => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const toWorld = (point: Point): Point => screenToWorld(cb.getCamera(), cb.getView(), point);

  function centreOf(points: Point[]): Point {
    const sum = points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
    return { x: sum.x / points.length, y: sum.y / points.length };
  }
  function spreadOf(points: Point[]): number {
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  function onPointerDown(event: PointerEvent): void {
    // Capture keeps a drag alive if the finger leaves the canvas. It throws for
    // pointer ids the browser does not consider active, which must not abort
    // the gesture.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* not capturable; the gesture still works */
    }
    pointers.set(event.pointerId, toLocal(event));
    const points = [...pointers.values()];

    if (points.length >= 2) {
      mode = 'pinch';
      moved = false;
      pinchDistance = spreadOf(points);
      last = centreOf(points);
      cb.onAimMove(null);
      return;
    }

    moved = false;
    rightButton = event.button === 2;
    last = points[0];

    if (rightButton) {
      mode = 'pan';
    } else if (cb.isAiming()) {
      mode = 'aim';
      cb.onAimMove(toWorld(last));
    } else {
      // Undecided: a tap until it moves far enough to be a drag.
      mode = 'press';
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!pointers.has(event.pointerId)) {
      if (event.pointerType === 'mouse') cb.onHover(toWorld(toLocal(event)));
      return;
    }
    pointers.set(event.pointerId, toLocal(event));
    const points = [...pointers.values()];

    if (mode === 'pinch') {
      if (points.length < 2) return;
      const centre = centreOf(points);
      const spread = spreadOf(points);
      const view = cb.getView();
      // Pan by the midpoint, zoom by how far the fingers spread.
      let camera = panByScreen(cb.getCamera(), view, centre.x - last.x, centre.y - last.y);
      if (pinchDistance > 0 && spread > 0) {
        camera = zoomAt(camera, view, centre, spread / pinchDistance);
      }
      cb.setCamera(camera);
      last = centre;
      pinchDistance = spread;
      moved = true;
      return;
    }

    const current = points[0];
    const dx = current.x - last.x;
    const dy = current.y - last.y;
    if (!moved && Math.hypot(dx, dy) > TAP_SLOP) moved = true;

    if (mode === 'press' && moved) mode = 'pan';

    if (mode === 'pan') {
      cb.setCamera(panByScreen(cb.getCamera(), cb.getView(), dx, dy));
      last = current;
    } else if (mode === 'aim') {
      cb.onAimMove(toWorld(current));
      last = current;
    }
    if (event.pointerType === 'mouse') cb.onHover(toWorld(current));
  }

  function onPointerUp(event: PointerEvent): void {
    const released = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    try {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }

    if (mode === 'pinch') {
      // Wait for a clean new gesture rather than snapping into a pan.
      if (pointers.size === 0) mode = 'idle';
      return;
    }
    if (!released) return;

    if (mode === 'press' && !moved) {
      cb.onTap(toWorld(released));
    } else if (mode === 'aim') {
      cb.onAimRelease(toWorld(released));
    } else if (mode === 'pan' && rightButton && !moved) {
      cb.onCancel();
    }

    mode = 'idle';
    rightButton = false;
  }

  function onPointerCancel(event: PointerEvent): void {
    pointers.delete(event.pointerId);
    if (pointers.size === 0) {
      mode = 'idle';
      cb.onAimMove(null);
    }
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // Normalise line/page deltas so a trackpad and a wheel feel similar.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const factor = Math.exp((-event.deltaY * unit) / 420);
    cb.setCamera(zoomAt(cb.getCamera(), cb.getView(), anchor, factor));
  }

  function onContextMenu(event: Event): void {
    event.preventDefault();
  }

  function onPointerLeave(event: PointerEvent): void {
    if (event.pointerType === 'mouse') cb.onHover(null);
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContextMenu);
  };
}
