import { WORLD_HEIGHT, WORLD_WIDTH } from '../shared/config';
import type { NodeSnapshot, Snapshot } from '../shared/types';

export interface PreviewLine {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  valid: boolean;
  label: string;
}

export interface RenderState {
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

export function render(ctx: CanvasRenderingContext2D, state: RenderState): void {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  drawGrid(ctx);

  const snapshot = state.snapshot;
  if (!snapshot) return;

  const colors = new Map(snapshot.players.map((p) => [p.id, p.color]));
  const nodes = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const colorOf = (ownerId: string): string => colors.get(ownerId) ?? '#8d94a3';

  // --- finished supply lines
  for (const edge of snapshot.edges) {
    const a = nodes.get(edge.nodeA);
    const b = nodes.get(edge.nodeB);
    if (!a || !b) continue;
    ctx.strokeStyle = colorOf(edge.ownerId);
    ctx.lineWidth = 3;
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

    ctx.save();
    ctx.strokeStyle = colorOf(construction.ownerId);
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([7, 7]);
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(construction.targetX, construction.targetY);
    ctx.stroke();

    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 3;
    ctx.setLineDash([9, 6]);
    ctx.lineDashOffset = -(serverNow / 28) % 15;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.restore();
  }

  // --- preview line
  if (state.preview) {
    const p = state.preview;
    ctx.save();
    ctx.strokeStyle = p.valid ? '#6ee36e' : '#ff6b5e';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(p.fromX, p.fromY);
    ctx.lineTo(p.toX, p.toY);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = p.valid ? '#6ee36e' : '#ff6b5e';
    ctx.font = '14px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.label, p.toX + 14, p.toY - 12);
  }

  // --- nodes
  for (const node of snapshot.nodes) {
    drawNode(ctx, node, colorOf(node.ownerId), node.id === state.selectedNodeId, node.id === state.hoverNodeId);
  }
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: NodeSnapshot,
  color: string,
  selected: boolean,
  hovered: boolean,
): void {
  const radius = node.type === 'hq' ? 17 : node.type === 'base' ? 9 : 5;

  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = node.connected ? 1 : 0.42; // unsupplied nodes fade out
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.lineWidth = 2;
  ctx.strokeStyle = '#11141a';
  ctx.stroke();

  if (node.type === 'hq') {
    ctx.fillStyle = '#11141a';
    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('H', node.x, node.y + 1);
  }

  if (selected || hovered) {
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius + (selected ? 7 : 4), 0, Math.PI * 2);
    ctx.strokeStyle = selected ? '#ffffff' : 'rgba(255,255,255,0.45)';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.stroke();
  }

  // stock readout: a short bar plus the number
  const barWidth = node.type === 'hq' ? 44 : 26;
  const fill = node.capacity > 0 ? clamp01(node.stock / node.capacity) : 0;
  const barY = node.y + radius + 6;
  ctx.fillStyle = 'rgba(17,20,26,0.8)';
  ctx.fillRect(node.x - barWidth / 2, barY, barWidth, 4);
  ctx.fillStyle = color;
  ctx.fillRect(node.x - barWidth / 2, barY, barWidth * fill, 4);

  ctx.fillStyle = '#c9cede';
  ctx.font = `${node.type === 'hq' ? 12 : 10}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(String(Math.floor(node.stock)), node.x, barY + 8);
}

function drawGrid(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 100; x < WORLD_WIDTH; x += 100) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, WORLD_HEIGHT);
  }
  for (let y = 100; y < WORLD_HEIGHT; y += 100) {
    ctx.moveTo(0, y);
    ctx.lineTo(WORLD_WIDTH, y);
  }
  ctx.stroke();
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
