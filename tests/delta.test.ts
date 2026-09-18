import { describe, expect, it } from 'vitest';
import { applySnapshotMessage, diffSnapshot } from '../src/shared/delta';
import type { Snapshot } from '../src/shared/types';
import { GameRoom } from '../src/game/room';
import { addEdge, addNode, findHq } from '../src/game/world';
import { TICK_INTERVAL_MS } from '../src/shared/config';

function baseSnapshot(): Snapshot {
  return {
    roomCode: 'TEST',
    status: 'playing',
    serverTime: 1000,
    winnerId: null,
    hostId: 'p1',
    players: [
      { id: 'p1', name: 'A', color: '#f00', alive: true, connected: true, isHost: true },
      { id: 'p2', name: 'B', color: '#00f', alive: true, connected: true, isHost: false },
    ],
    nodes: [
      { id: 'n1', ownerId: 'p1', type: 'hq', x: 100, y: 100, stock: 200, connected: true },
      { id: 'n2', ownerId: 'p1', type: 'base', x: 200, y: 100, stock: 50, connected: true },
    ],
    edges: [{ id: 'e1', ownerId: 'p1', nodeA: 'n1', nodeB: 'n2' }],
    constructions: [],
  };
}

const clone = (s: Snapshot): Snapshot => JSON.parse(JSON.stringify(s)) as Snapshot;

describe('snapshot deltas', () => {
  it('sends a full message when there is nothing to diff against', () => {
    const message = diffSnapshot(null, baseSnapshot());
    expect(message.full).toBe(true);
    expect(applySnapshotMessage(null, message)).toEqual(baseSnapshot());
  });

  it('refuses to build a view from a delta alone', () => {
    const delta = diffSnapshot(baseSnapshot(), baseSnapshot());
    expect(delta.full).toBe(false);
    expect(applySnapshotMessage(null, delta)).toBeNull();
  });

  it('carries nothing but the header when nothing changed', () => {
    const delta = diffSnapshot(baseSnapshot(), baseSnapshot());
    if (delta.full) throw new Error('expected a delta');
    expect(delta.nodes).toBeUndefined();
    expect(delta.edges).toBeUndefined();
    expect(delta.players).toBeUndefined();
    expect(delta.removedNodes).toBeUndefined();
    expect(delta.removedEdges).toBeUndefined();
  });

  it('sends only the node whose stock moved', () => {
    const previous = baseSnapshot();
    const next = clone(previous);
    next.nodes[1].stock = 62;

    const delta = diffSnapshot(previous, next);
    if (delta.full) throw new Error('expected a delta');
    expect(delta.nodes).toHaveLength(1);
    expect(delta.nodes?.[0].id).toBe('n2');
    expect(applySnapshotMessage(previous, delta)).toEqual(next);
  });

  it('applies ownership changes, additions and removals together', () => {
    const previous = baseSnapshot();
    const next = clone(previous);
    next.nodes[1].ownerId = 'p2'; // captured
    next.nodes.push({ id: 'n3', ownerId: 'p1', type: 'base', x: 300, y: 100, stock: 0, connected: true });
    next.edges = [{ id: 'e2', ownerId: 'p1', nodeA: 'n1', nodeB: 'n3' }]; // e1 cut

    const delta = diffSnapshot(previous, next);
    if (delta.full) throw new Error('expected a delta');
    expect(delta.removedEdges).toEqual(['e1']);
    expect(delta.edges?.map((e) => e.id)).toEqual(['e2']);
    expect(applySnapshotMessage(previous, delta)).toEqual(next);
  });

  it('drops nodes that disappeared', () => {
    const previous = baseSnapshot();
    const next = clone(previous);
    next.nodes = next.nodes.filter((n) => n.id !== 'n2');
    next.edges = [];

    const delta = diffSnapshot(previous, next);
    if (delta.full) throw new Error('expected a delta');
    expect(delta.removedNodes).toEqual(['n2']);
    expect(applySnapshotMessage(previous, delta)).toEqual(next);
  });

  it('sends the roster only when it actually changes', () => {
    const previous = baseSnapshot();
    const same = diffSnapshot(previous, clone(previous));
    if (same.full) throw new Error('expected a delta');
    expect(same.players).toBeUndefined();

    const next = clone(previous);
    next.players[1].alive = false;
    const changed = diffSnapshot(previous, next);
    if (changed.full) throw new Error('expected a delta');
    expect(changed.players).toBeDefined();
    expect(applySnapshotMessage(previous, changed)).toEqual(next);
  });

  /**
   * The property that matters: a client replaying every delta must end up with
   * exactly what a client receiving full snapshots would have.
   */
  it('stays identical to full snapshots across a whole match', () => {
    const room = new GameRoom({ code: 'SYNC', random: () => 0 });
    const a = room.addPlayer('A', 's1', 0);
    const b = room.addPlayer('B', 's2', 0);
    if ('error' in a || 'error' in b) throw new Error('setup');
    room.start(0);

    const hq = findHq(room.world, a.id)!;
    let now = 0;
    let view: Snapshot | null = null;
    let previous: Snapshot | null = null;

    for (let step = 0; step < 400; step++) {
      now += TICK_INTERVAL_MS;
      room.tick(now);

      // Churn the world: build, capture and remove things as a match would.
      if (step === 40) {
        const n = addNode(room.world, a.id, 'base', hq.x + 60, hq.y + 60, 0);
        addEdge(room.world, a.id, hq.id, n.id);
      }
      if (step === 90) {
        for (const node of room.world.nodes.values()) {
          if (node.ownerId === a.id && node.type === 'base') node.ownerId = b.id;
        }
      }
      if (step === 140) {
        const victim = [...room.world.nodes.values()].find((n) => n.type === 'base');
        if (victim) room.world.nodes.delete(victim.id);
      }

      if (step % 2 === 0) {
        const truth = room.snapshot(now);
        const message = diffSnapshot(previous, truth);
        view = applySnapshotMessage(view, message);
        previous = truth;

        expect(view).not.toBeNull();
        // Order is not meaningful on the wire; compare as sets.
        const sorted = (s: Snapshot) => ({
          ...s,
          nodes: [...s.nodes].sort((x, y) => x.id.localeCompare(y.id)),
          edges: [...s.edges].sort((x, y) => x.id.localeCompare(y.id)),
        });
        expect(sorted(view as Snapshot)).toEqual(sorted(truth));
      }
    }
  });
});
