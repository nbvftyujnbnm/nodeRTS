import { GameRoom } from '../src/game/room';
import { addEdge, addNode, createWorld, type World } from '../src/game/world';
import type { GameNode } from '../src/shared/types';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../src/shared/config';

export interface Scenario {
  world: World;
  node(owner: string, type: 'hq' | 'base' | 'junction', x: number, y: number, stock?: number): GameNode;
  link(owner: string, a: GameNode, b: GameNode): void;
  hqOf(playerId: string): string | null;
}

export function scenario(): Scenario {
  const world = createWorld();
  return {
    world,
    node: (owner, type, x, y, stock = 0) => addNode(world, owner, type, x, y, stock),
    link: (owner, a, b) => {
      addEdge(world, owner, a.id, b.id);
    },
    hqOf: (playerId) => {
      for (const node of world.nodes.values()) {
        if (node.ownerId === playerId && node.type === 'hq') return node.id;
      }
      return null;
    },
  };
}

export function edgeBetween(world: World, a: string, b: string) {
  for (const edge of world.edges.values()) {
    if ((edge.nodeA === a && edge.nodeB === b) || (edge.nodeA === b && edge.nodeB === a)) return edge;
  }
  return undefined;
}

export function ownedNodes(world: World, ownerId: string): GameNode[] {
  return [...world.nodes.values()].filter((n) => n.ownerId === ownerId);
}

/** A started room with `count` players and deterministic reconnect tokens. */
export function startedRoom(count: number, now = 1_000): { room: GameRoom; ids: string[] } {
  let tokenCounter = 0;
  const room = new GameRoom({
    code: 'TEST',
    tokenFactory: () => `token-${++tokenCounter}`,
    random: () => 0, // pin the seat draw so positions are stable across runs
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const player = room.addPlayer(`P${i + 1}`, `socket-${i + 1}`, now);
    if ('error' in player) throw new Error(player.error);
    ids.push(player.id);
  }
  room.start(now);
  room.drainEvents();
  return { room, ids };
}

export function hqNode(room: GameRoom, playerId: string): GameNode {
  for (const node of room.world.nodes.values()) {
    if (node.ownerId === playerId && node.type === 'hq') return node;
  }
  throw new Error(`no HQ for ${playerId}`);
}

/**
 * Advance the room past a construction's finish time using a tiny final tick,
 * so the supply pass that follows completion cannot mask "stock was reset".
 * Returns the new "now".
 */
export function finishBuild(room: GameRoom, startedAt: number, buildTimeSeconds: number): number {
  const finish = startedAt + buildTimeSeconds * 1000;
  room.tick(finish - 1);
  room.tick(finish + 1);
  return finish + 1;
}

/**
 * A point `distance` away from `from`, aimed at the middle of the map.
 *
 * Spawns sit near the edge, so any test that builds in a fixed compass
 * direction will sooner or later aim out of the world and fail for the wrong
 * reason. Aiming inwards is always legal.
 */
export function towardCentre(
  from: { x: number; y: number },
  distance: number,
): { x: number; y: number } {
  const dx = WORLD_WIDTH / 2 - from.x;
  const dy = WORLD_HEIGHT / 2 - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / len) * distance, y: from.y + (dy / len) * distance };
}

/** Sideways from the line to the map centre, which also stays in bounds. */
export function besideCentreLine(
  from: { x: number; y: number },
  distance: number,
): { x: number; y: number } {
  const dx = WORLD_WIDTH / 2 - from.x;
  const dy = WORLD_HEIGHT / 2 - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: from.x + (-dy / len) * distance, y: from.y + (dx / len) * distance };
}
