import { HQ_CAPTURE_RADIUS, NODE_SNAP_RADIUS } from '../shared/config';
import type { GameNode } from '../shared/types';
import { distance } from './geometry';
import { sortIds } from './graph';

export type ResolvedTargetKind = 'enemyHq' | 'snap' | 'new';

export interface ResolvedTarget {
  kind: ResolvedTargetKind;
  /** Existing node the target resolved onto, if any. */
  node: GameNode | null;
  /** Final (possibly snapped) world position. */
  x: number;
  y: number;
}

/**
 * Decide what a build click actually aims at.
 *
 * Priority:
 *  1. An alive enemy HQ within HQ_CAPTURE_RADIUS -> snap to its centre.
 *  2. One of your own nodes within NODE_SNAP_RADIUS -> snap onto it (this is
 *     how players build loops and redundant routes).
 *  3. Otherwise a brand new base at the clicked point.
 *
 * Shared by the server (authoritative) and the client (preview only), so the
 * numbers shown while aiming match what the server will actually do.
 */
export function resolveBuildTarget(
  nodes: Iterable<GameNode>,
  ownerId: string,
  sourceNodeId: string,
  x: number,
  y: number,
  alivePlayerIds: ReadonlySet<string>,
): ResolvedTarget {
  const point = { x, y };
  let bestHq: GameNode | null = null;
  let bestHqDist = Infinity;
  let bestOwn: GameNode | null = null;
  let bestOwnDist = Infinity;

  for (const node of nodes) {
    const d = distance(point, node);
    if (
      node.type === 'hq' &&
      node.ownerId !== ownerId &&
      alivePlayerIds.has(node.ownerId) &&
      d <= HQ_CAPTURE_RADIUS
    ) {
      if (d < bestHqDist || (d === bestHqDist && isLowerId(node.id, bestHq?.id))) {
        bestHq = node;
        bestHqDist = d;
      }
    }
    // Junctions are invisible plumbing, so they are not snap targets either -
    // a line must never land somewhere the player cannot see.
    if (
      node.ownerId === ownerId &&
      node.type !== 'junction' &&
      node.id !== sourceNodeId &&
      d <= NODE_SNAP_RADIUS
    ) {
      if (d < bestOwnDist || (d === bestOwnDist && isLowerId(node.id, bestOwn?.id))) {
        bestOwn = node;
        bestOwnDist = d;
      }
    }
  }

  if (bestHq) return { kind: 'enemyHq', node: bestHq, x: bestHq.x, y: bestHq.y };
  if (bestOwn) return { kind: 'snap', node: bestOwn, x: bestOwn.x, y: bestOwn.y };
  return { kind: 'new', node: null, x, y };
}

function isLowerId(candidate: string, current: string | undefined): boolean {
  if (current === undefined) return true;
  return sortIds([candidate, current])[0] === candidate;
}
