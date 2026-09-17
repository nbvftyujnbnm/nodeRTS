import { describe, expect, it } from 'vitest';
import { addEdge, addNode } from '../src/game/world';
import { buildTimeForDistance } from '../src/shared/config';
import { finishBuild, hqNode, startedRoom } from './helpers';

/**
 * End-to-end through the room API: a real build request that cuts a real enemy
 * line and captures the far side, with events emitted to clients.
 */
describe('cutting an enemy network through the room API', () => {
  function stage() {
    const { room, ids } = startedRoom(2);
    const [attacker, victim] = ids;

    // Victim chain running horizontally at y = 450.
    const vHq = hqNode(room, victim);
    vHq.x = 200;
    vHq.y = 450;
    const vA = addNode(room.world, victim, 'base', 400, 450, 40);
    const vB = addNode(room.world, victim, 'base', 700, 450, 70);
    const vC = addNode(room.world, victim, 'base', 900, 450, 90);
    addEdge(room.world, victim, vHq.id, vA.id);
    addEdge(room.world, victim, vA.id, vB.id);
    addEdge(room.world, victim, vB.id, vC.id);

    // Attacker staging post below the victim chain.
    const aHq = hqNode(room, attacker);
    aHq.x = 550;
    aHq.y = 800;
    aHq.stock = 500;

    return { room, attacker, victim, vA, vB, vC, aHq };
  }

  it('cuts, captures and reports events', () => {
    const { room, attacker, victim, vA, vB, vC, aHq } = stage();
    room.drainEvents();

    // Build straight up from the attacker HQ across the victim's A--B edge.
    const result = room.requestBuild(attacker, aHq.id, 550, 400, 2_000);
    expect(result.ok).toBe(true);

    finishBuild(room, 2_000, result.evaluation?.buildTime ?? 1);
    const events = room.drainEvents();
    const types = events.map((e) => e.type);

    expect(types).toContain('constructionCompleted');
    expect(types).toContain('supplyLineCut');
    expect(types).toContain('networkCaptured');

    const capture = events.find((e) => e.type === 'networkCaptured');
    expect(capture).toBeDefined();
    if (capture && capture.type === 'networkCaptured') {
      expect(capture.attackerId).toBe(attacker);
      expect(capture.victimId).toBe(victim);
      expect(capture.nodeIds).toEqual([vB.id, vC.id]);
    }

    expect(room.world.nodes.get(vB.id)!.ownerId).toBe(attacker);
    expect(room.world.nodes.get(vC.id)!.ownerId).toBe(attacker);
    expect(room.world.nodes.get(vB.id)!.stock).toBeLessThan(1); // reset on capture
    expect(room.world.nodes.get(vA.id)!.ownerId).toBe(victim);
  });

  it('supplies the captured territory from the attacker HQ afterwards', () => {
    const { room, attacker, vB, aHq } = stage();
    const result = room.requestBuild(attacker, aHq.id, 550, 400, 2_000);
    let now = finishBuild(room, 2_000, result.evaluation?.buildTime ?? 1);

    expect(room.connectedNodeIds(attacker).has(vB.id)).toBe(true);
    for (let i = 0; i < 40; i++) {
      now += 50;
      room.tick(now);
    }
    expect(room.world.nodes.get(vB.id)!.stock).toBeGreaterThan(1);
  });

  it('leaves the victim intact when a redundant route survives the cut', () => {
    const { room, attacker, victim, vA, vB, vC, aHq } = stage();
    // Alternate route A -> D -> E -> C that stays clear of the attack line
    // segment (x = 550, y from 400 to 800).
    const d = addNode(room.world, victim, 'base', 400, 200, 10);
    const e = addNode(room.world, victim, 'base', 900, 200, 10);
    addEdge(room.world, victim, vA.id, d.id);
    addEdge(room.world, victim, d.id, e.id);
    addEdge(room.world, victim, e.id, vC.id);

    const result = room.requestBuild(attacker, aHq.id, 550, 400, 2_000);
    finishBuild(room, 2_000, result.evaluation?.buildTime ?? 1);

    expect(room.world.nodes.get(vB.id)!.ownerId).toBe(victim);
    expect(room.world.nodes.get(vC.id)!.ownerId).toBe(victim);
    expect(room.world.nodes.get(vB.id)!.stock).toBeGreaterThanOrEqual(70); // never reset
    // The crossed edge is still severed.
    const stillLinked = [...room.world.edges.values()].some(
      (edge) =>
        (edge.nodeA === vA.id && edge.nodeB === vB.id) ||
        (edge.nodeA === vB.id && edge.nodeB === vA.id),
    );
    expect(stillLinked).toBe(false);
  });

  it('produces snapshots the client can render', () => {
    const { room, attacker } = stage();
    room.tick(2_000);
    const snapshot = room.snapshot(2_000);

    expect(snapshot.roomCode).toBe('TEST');
    expect(snapshot.status).toBe('playing');
    expect(snapshot.players).toHaveLength(2);
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    const hq = snapshot.nodes.find((n) => n.ownerId === attacker && n.type === 'hq');
    expect(hq?.connected).toBe(true);
    expect(hq?.capacity).toBe(500);
    // No server-only fields leak into the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain('reconnectToken');
    expect(JSON.stringify(snapshot)).not.toContain('socketId');
  });

  it('marks nodes cut off from the HQ as unsupplied in snapshots', () => {
    const { room, victim, vB } = stage();
    room.tick(2_000);
    // Sever the chain by hand and re-run a tick.
    for (const [id, edge] of [...room.world.edges]) {
      if (edge.ownerId === victim && edge.length === 300) room.world.edges.delete(id);
    }
    room.tick(2_050);
    const snapshot = room.snapshot(2_050);
    expect(snapshot.nodes.find((n) => n.id === vB.id)!.connected).toBe(false);
  });
});
