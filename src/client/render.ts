import { capacityForNodeType } from '../shared/config';
import type { NodeSnapshot, Snapshot } from '../shared/types';
import { visibleBounds, type Bounds, type Camera, type Viewport } from './camera';

/**
 * Screen-space sizes, in CSS pixels. Radii, strokes and text are drawn in world
 * units but floored against these, so a board fitted onto a phone stays
 * readable and tappable instead of collapsing into specks.
 */
const MIN_SCREEN_RADIUS = { hq: 13, base: 8, junction: 5 } as const;

export interface PreviewLine {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  valid: boolean;
  label: string;
}

export interface RenderState {
  camera: Camera;
  view: Viewport;
  /** Device pixel ratio the backing store was sized with. */
  dpr: number;
  snapshot: Snapshot | null;
  /** Local ms timestamp when the snapshot arrived, for smooth build animation. */
  snapshotReceivedAt: number;
  youId: string | null;
  selectedNodeId: string | null;
  hoverNodeId: string | null;
  preview: PreviewLine | null;
}

const BACKGROUND = '#2a2d33';
const GRID = '#31353c';
const GRID_MAJOR = '#3a3f48';

export function render(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { camera, view, dpr } = state;

  // The board has no edges, so the background simply is the viewport.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, view.width, view.height);

  // From here on, draw in world coordinates.
  ctx.translate(view.width / 2, view.height / 2);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(-camera.x, -camera.y);

  /** World units per CSS pixel: multiply screen sizes by this. */
  const k = 1 / camera.scale;

  drawGrid(ctx, visibleBounds(camera, view), camera.scale, k);

  const snapshot = state.snapshot;
  if (!snapshot) return;

  const { colors, initials, nodes } = lookupsFor(snapshot);
  const colorOf = (ownerId: string): string => colors.get(ownerId) ?? '#8d94a3';

  // --- finished supply lines
  for (const edge of snapshot.edges) {
    const a = nodes.get(edge.nodeA);
    const b = nodes.get(edge.nodeB);
    if (!a || !b) continue;
    ctx.strokeStyle = colorOf(edge.ownerId);
    ctx.lineWidth = 3 * k;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // --- constructions in progress (purely visual interpolation)
  const serverNow = snapshot.serverTime + (performance.now() - state.snapshotReceivedAt);
  for (const construction of snapshot.constructions) {
    const source = nodes.get(construction.sourceNodeId);
    if (!source) continue;
    const span = Math.max(1, construction.finishTime - construction.startTime);
    const progress = clamp01((serverNow - construction.startTime) / span);
    const tipX = source.x + (construction.targetX - source.x) * progress;
    const tipY = source.y + (construction.targetY - source.y) * progress;

    const assault = construction.assaultOnPlayerId !== null;

    ctx.save();
    ctx.strokeStyle = colorOf(construction.ownerId);
    ctx.lineWidth = 2 * k;
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([7 * k, 7 * k]);
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(construction.targetX, construction.targetY);
    ctx.stroke();

    ctx.globalAlpha = 0.95;
    ctx.lineWidth = (assault ? 6 : 3) * k;
    ctx.setLineDash([9 * k, 6 * k]);
    ctx.lineDashOffset = (-(serverNow / 28) % 15) * k;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // An assault is the one build that ends someone's match; make it unmissable.
    if (assault) {
      ctx.globalAlpha = 0.45 + 0.35 * Math.sin(serverNow / 120);
      ctx.strokeStyle = '#ff5a4d';
      ctx.lineWidth = 12 * k;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(construction.targetX, construction.targetY, (26 + 8 * Math.sin(serverNow / 140)) * k, 0, Math.PI * 2);
      ctx.strokeStyle = '#ff5a4d';
      ctx.lineWidth = 2.5 * k;
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- preview line
  if (state.preview) {
    const p = state.preview;
    ctx.save();
    ctx.strokeStyle = p.valid ? '#6ee36e' : '#ff6b5e';
    ctx.lineWidth = 2 * k;
    ctx.setLineDash([6 * k, 5 * k]);
    ctx.beginPath();
    ctx.moveTo(p.fromX, p.fromY);
    ctx.lineTo(p.toX, p.toY);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = p.valid ? '#6ee36e' : '#ff6b5e';
    ctx.font = `${14 * k}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.label, p.toX + 14 * k, p.toY - 12 * k);
  }

  // --- nodes
  for (const node of snapshot.nodes) {
    // Junctions are not drawn. They exist so the graph knows where lines meet;
    // on screen a crossing should just look like two lines crossing, and the
    // split halves are collinear with the originals, so nothing is lost.
    if (node.type === 'junction') continue;
    drawNode(
      ctx,
      node,
      colorOf(node.ownerId),
      node.id === state.selectedNodeId,
      node.id === state.hoverNodeId,
      k,
      initials.get(node.ownerId) ?? '?',
    );
  }
}

/**
 * On-screen radius of a node, in world units. Shared with hit testing so what
 * you can tap is exactly what you can see.
 */
interface Lookups {
  colors: Map<string, string>;
  initials: Map<string, string>;
  nodes: Map<string, NodeSnapshot>;
}

let cachedSnapshot: Snapshot | null = null;
let cachedLookups: Lookups | null = null;

/**
 * Index the snapshot once per snapshot rather than once per frame. Snapshots
 * are replaced wholesale when one arrives, so identity is a safe cache key,
 * and at sixty frames a second a large board was rebuilding hundreds of map
 * entries for every single one.
 */
function lookupsFor(snapshot: Snapshot): Lookups {
  if (cachedSnapshot === snapshot && cachedLookups) return cachedLookups;
  const lookups: Lookups = {
    colors: new Map(snapshot.players.map((p) => [p.id, p.color])),
    initials: new Map(snapshot.players.map((p) => [p.id, initialOf(p.name)])),
    nodes: new Map(snapshot.nodes.map((n) => [n.id, n])),
  };
  cachedSnapshot = snapshot;
  cachedLookups = lookups;
  return lookups;
}

/** First visible character of a name, for the badge on a headquarters. */
export function initialOf(name: string): string {
  for (const character of Array.from(name)) {
    if (character.trim().length > 0) return character.toUpperCase();
  }
  return '?';
}

export function nodeRadius(type: NodeSnapshot['type'], worldPerPixel: number): number {
  const base = type === 'hq' ? 17 : type === 'base' ? 9 : 5;
  return Math.max(base, MIN_SCREEN_RADIUS[type] * worldPerPixel);
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: NodeSnapshot,
  color: string,
  selected: boolean,
  hovered: boolean,
  k: number,
  initial: string,
): void {
  const radius = nodeRadius(node.type, k);

  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = node.connected ? 1 : 0.42; // unsupplied nodes fade out
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.lineWidth = 2 * k;
  ctx.strokeStyle = '#11141a';
  ctx.stroke();

  if (node.type === 'hq') {
    ctx.fillStyle = '#11141a';
    ctx.font = `bold ${Math.max(18, radius * 1.05)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, node.x, node.y + 1);
  }

  if (selected || hovered) {
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius + (selected ? 7 : 4) * k, 0, Math.PI * 2);
    ctx.strokeStyle = selected ? '#ffffff' : 'rgba(255,255,255,0.45)';
    ctx.lineWidth = (selected ? 2 : 1) * k;
    ctx.stroke();
  }

  // Stock readout: a short bar plus the number. Junctions store nothing, so
  // they get no gauge - an empty bar under every crossing is just noise.
  const capacity = capacityForNodeType(node.type);
  if (capacity <= 0) return;
  const barWidth = (node.type === 'hq' ? 44 : 26) * k;
  const barHeight = 4 * k;
  const fill = clamp01(node.stock / capacity);
  const barY = node.y + radius + 6 * k;
  ctx.fillStyle = 'rgba(17,20,26,0.8)';
  ctx.fillRect(node.x - barWidth / 2, barY, barWidth, barHeight);
  ctx.fillStyle = color;
  ctx.fillRect(node.x - barWidth / 2, barY, barWidth * fill, barHeight);

  ctx.fillStyle = '#c9cede';
  ctx.font = `${(node.type === 'hq' ? 12 : 10) * k}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(String(Math.floor(node.stock)), node.x, barY + 8 * k);
}

/**
 * Grid over whatever is on screen.
 *
 * On an infinite canvas the grid is the only thing telling you that you are
 * moving, so the spacing adapts to the zoom: it steps through 1-2-5 x 10^n and
 * picks the one that lands closest to a comfortable on-screen size, with every
 * fifth line brighter so there is something to judge distance against.
 */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  bounds: Bounds,
  scale: number,
  k: number,
): void {
  const spacing = gridSpacing(scale);
  const major = spacing * 5;

  const firstX = Math.floor(bounds.minX / spacing) * spacing;
  const firstY = Math.floor(bounds.minY / spacing) * spacing;
  // Safety net: never try to draw more lines than could possibly be useful.
  const maxLines = 400;

  for (const pass of [false, true]) {
    ctx.strokeStyle = pass ? GRID_MAJOR : GRID;
    ctx.lineWidth = (pass ? 1.4 : 1) * k;
    ctx.beginPath();

    let drawn = 0;
    for (let x = firstX; x <= bounds.maxX && drawn < maxLines; x += spacing, drawn++) {
      if ((Math.abs(Math.round(x / major) * major - x) < spacing / 2) !== pass) continue;
      ctx.moveTo(x, bounds.minY);
      ctx.lineTo(x, bounds.maxY);
    }
    drawn = 0;
    for (let y = firstY; y <= bounds.maxY && drawn < maxLines; y += spacing, drawn++) {
      if ((Math.abs(Math.round(y / major) * major - y) < spacing / 2) !== pass) continue;
      ctx.moveTo(bounds.minX, y);
      ctx.lineTo(bounds.maxX, y);
    }
    ctx.stroke();
  }
}

/**
 * World units between grid lines, chosen to sit near 110 screen pixels.
 *
 * Picks the 1-2-5 step closest to the target in log space rather than the next
 * one up: rounding up alone let the spacing drift to two and a half times the
 * target, which reads as a nearly empty screen at some zoom levels.
 */
export function gridSpacing(scale: number, targetScreenPx = 110): number {
  const raw = targetScreenPx / Math.max(scale, 1e-9);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  let best = magnitude;
  let bestError = Infinity;
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude;
    const error = Math.abs(Math.log(candidate / raw));
    if (error < bestError) {
      bestError = error;
      best = candidate;
    }
  }
  return best;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
