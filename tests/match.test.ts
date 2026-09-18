import { describe, expect, it } from 'vitest';
import { GameRoom } from '../src/game/room';
import { addEdge, addNode } from '../src/game/world';
import {
  BASE_MAX_STOCK,
  BUILD_REQUEST_MIN_INTERVAL_MS,
  MAX_ACTIVE_CONSTRUCTIONS_PER_PLAYER,
  MAX_BUILD_DISTANCE,
  MAX_PLAYERS,
  MIN_BUILD_DISTANCE,
  RECONNECT_GRACE_MS,
  WORLD_WIDTH,
  buildCostForDistance,
  buildTimeForDistance,
} from '../src/shared/config';
import { besideCentreLine, finishBuild, hqNode, startedRoom, towardCentre } from './helpers';

/** Requirement 11: range, ownership, connectivity and resource validation. */
describe('build validation', () => {
  it('accepts a legal build from an owned, supplied node', () => {
    const { room, ids } = startedRoom(2);
    const hq = hqNode(room, ids[0]);
    const result = room.requestBuild(ids[0], hq.id, hq.x + 100, hq.y + 100, 2_000);
    expect(result.ok).toBe(true);
    expect(result.constructionId).toBe('c1');
  });

  it('rejects builds that are too far away', () => {
    const { room, ids } = startedRoom(2);
    const hq = hqNode(room, ids[0]);
    // Aim inwards, so an over-range build cannot also be out of bounds and
    // trip the bounds check first.
    const inwards = hq.x > WORLD_WIDTH / 2 ? -1 : 1;
    const result = room.requestBuild(
      ids[0],
      hq.id,
      hq.x + inwards * (MAX_BUILD_DISTANCE + 10),
      hq.y,
      2_000,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('too far');
  });

  it('rejects builds that are too close', () => {
    const { room, ids } = startedRoom(2);
    const hq = hqNode(room, ids[0]);
    const result = room.requestBuild(ids[0], hq.id, hq.x + MIN_BUILD_DISTANCE - 5, hq.y, 2_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('too close');
  });

  it('rejects builds the source cannot pay for', () => {
    const { room, ids } = startedRoom(2);
    const hq = hqNode(room, ids[0]);
    hq.stock = 5;
    const result = room.requestBuild(ids[0], hq.id, hq.x + 100, hq.y + 100, 2_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not enough resources at source');
  });

  it('rejects building from a node you do not own', () => {
    const { room, ids } = startedRoom(2);
    const enemyHq = hqNode(room, ids[1]);
    const aim = towardCentre(enemyHq, 100);
    const result = room.requestBuild(ids[0], enemyHq.id, aim.x, aim.y, 2_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source node is not yours');
  });

  it('rejects building from a node that is cut off from the HQ', () => {
    const { room, ids } = startedRoom(2);
    const orphan = addNode(room.world, ids[0], 'base', 400, 400, 200);
    const result = room.requestBuild(ids[0], orphan.id, 500, 500, 2_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source is not supplied by your HQ');
  });

  it('rejects unknown nodes and non-finite coordinates', () => {
    const { room, ids } = startedRoom(2);
    expect(room.requestBuild(ids[0], 'nope', 100, 100, 2_000).reason).toBe(
      'source node does not exist',
    );
    const hq = hqNode(room, ids[0]);
    expect(room.requestBuild(ids[0], hq.id, Number.NaN, 100, 3_000).reason).toBe(
      'invalid target coordinates',
    );
    expect(room.requestBuild(ids[0], hq.id, 99_999, 100, 4_000).reason).toBe(
      'target outside world bounds',
    );
    expect(room.requestBuild(ids[0], 42 as unknown as string, 100, 100, 5_000).reason).toBe(
      'invalid source node id',
    );
  });

  it('deducts the cost immediately from the source node', () => {
    const { room, ids } = startedRoom(2);
    const hq = hqNode(room, ids[0]);
    const before = hq.stock;
    const distance = 200;
    room.requestBuild(ids[0], hq.id, hq.x, hq.y + distance, 2_000);
    expect(hq.stock).toBeCloseTo(before - buildCostForDistance(distance), 6);
  });

  it('enforces one construction per node and three per player', () => {
    const { room, ids } = startedRoom(2);
    const hq = hqNode(room, ids[0]);
    hq.stock = 500;
    let now = 2_000;
    const first = towardCentre(hq, 140);
    expect(room.requestBuild(ids[0], hq.id, first.x, first.y, now).ok).toBe(true);

    now += BUILD_REQUEST_MIN_INTERVAL_MS + 1;
    const again = towardCentre(hq, 220);
    const second = room.requestBuild(ids[0], hq.id, again.x, again.y, now);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('this node is already building');

    // Spread across separate nodes to reach the per-player cap.
    const sources = [0, 1, 2].map((i) => {
      const node = addNode(room.world, ids[0], 'base', 300 + i * 40, 450, 300);
      addEdge(room.world, ids[0], hq.id, node.id);
      return node;
    });
    for (const node of sources) {
      now += BUILD_REQUEST_MIN_INTERVAL_MS + 1;
      room.requestBuild(ids[0], node.id, node.x, node.y + 120, now);
    }
    expect(room.constructions.size).toBe(MAX_ACTIVE_CONSTRUCTIONS_PER_PLAYER);

    now += BUILD_REQUEST_MIN_INTERVAL_MS + 1;
    const overflow = room.requestBuild(ids[0], sources[2].id, sources[2].x, sources[2].y - 120, now);
    expect(overflow.ok).toBe(false);
    expect(overflow.reason).toContain('max 3 constructions');
  });

  it('rate-limits build spam', () => {
    const { room, ids } = startedRoom(2);
    const hq = hqNode(room, ids[0]);
    expect(room.requestBuild(ids[0], hq.id, hq.x + 100, hq.y + 100, 2_000).ok).toBe(true);
    const spam = room.requestBuild(ids[0], hq.id, hq.x - 100, hq.y + 100, 2_010);
    expect(spam.ok).toBe(false);
    expect(spam.reason).toBe('slow down');
  });
});

describe('construction lifecycle', () => {
  it('creates a base with zero stock when the timer completes', () => {
    const { room, ids } = startedRoom(2);
    const hq = hqNode(room, ids[0]);
    const distance = 200;
    room.requestBuild(ids[0], hq.id, hq.x, hq.y + distance, 2_000);
    expect(room.constructions.size).toBe(1);

    finishBuild(room, 2_000, buildTimeForDistance(distance));

    expect(room.constructions.size).toBe(0);
    const created = [...room.world.nodes.values()].find(
      (n) => n.ownerId === ids[0] && n.type === 'base',
    );
    expect(created).toBeDefined();
    expect(created!.stock).toBeCloseTo(0, 1);
    expect([...room.world.edges.values()]).toHaveLength(1);
  });

  it('refills the new base through the supply network over time', () => {
    const { room, ids } = startedRoom(2);
    const hq = hqNode(room, ids[0]);
    room.requestBuild(ids[0], hq.id, hq.x, hq.y + 200, 2_000);
    let now = finishBuild(room, 2_000, buildTimeForDistance(200));
    const base = [...room.world.nodes.values()].find(
      (n) => n.ownerId === ids[0] && n.type === 'base',
    )!;

    for (let i = 0; i < 20; i++) {
      now += 50;
      room.tick(now);
    }
    expect(base.stock).toBeGreaterThan(5);
  });
});

/** Requirements 12-15: HQ capture, elimination, snowballing and victory. */
describe('headquarters capture', () => {
  function stageAttack(playerCount: number) {
    const { room, ids } = startedRoom(playerCount);
    const attacker = ids[0];
    const victim = ids[1];
    const victimHq = hqNode(room, victim);
    const attackerHq = hqNode(room, attacker);

    // A forward base 180px from the victim HQ (towards the map centre so it is
    // always inside the world), wired back to the attacker HQ.
    const toCentre = { x: 800 - victimHq.x, y: 450 - victimHq.y };
    const len = Math.hypot(toCentre.x, toCentre.y) || 1;
    const forward = addNode(
      room.world,
      attacker,
      'base',
      victimHq.x + (toCentre.x / len) * 180,
      victimHq.y + (toCentre.y / len) * 180,
      BASE_MAX_STOCK,
    );
    addEdge(room.world, attacker, attackerHq.id, forward.id);

    // Give the victim something to inherit, off to one side so it does not sit
    // on the attacker's approach line.
    const aside = besideCentreLine(victimHq, 120);
    const victimBase = addNode(room.world, victim, 'base', aside.x, aside.y, 55);
    addEdge(room.world, victim, victimHq.id, victimBase.id);

    return { room, ids, attacker, victim, victimHq, forward, victimBase };
  }

  function runAttack(room: GameRoom, attacker: string, forwardId: string, hqX: number, hqY: number) {
    const result = room.requestBuild(attacker, forwardId, hqX, hqY, 2_000);
    expect(result.ok).toBe(true);
    finishBuild(room, 2_000, result.evaluation?.buildTime ?? 1);
  }

  it('eliminates the victim when a line completes onto their HQ', () => {
    const { room, attacker, victim, victimHq, forward } = stageAttack(3);
    runAttack(room, attacker, forward.id, victimHq.x, victimHq.y);

    expect(room.players.get(victim)!.alive).toBe(false);
  });

  it('ends a 2-player match immediately', () => {
    const { room, attacker, victim, victimHq, forward } = stageAttack(2);
    runAttack(room, attacker, forward.id, victimHq.x, victimHq.y);

    expect(room.status).toBe('finished');
    expect(room.winnerId).toBe(attacker);
    expect(room.players.get(victim)!.alive).toBe(false);
  });

  it('continues a 3-player match and transfers the assets to the attacker', () => {
    const { room, attacker, victim, victimHq, forward, victimBase } = stageAttack(3);
    runAttack(room, attacker, forward.id, victimHq.x, victimHq.y);

    expect(room.status).toBe('playing');
    expect(room.winnerId).toBeNull();

    const inherited = room.world.nodes.get(victimBase.id)!;
    expect(inherited.ownerId).toBe(attacker);
    expect(inherited.stock).toBeLessThan(1); // reset on transfer, then one tiny supply tick

    // The captured HQ becomes an ordinary base so nobody runs two HQs.
    const captured = room.world.nodes.get(victimHq.id)!;
    expect(captured.ownerId).toBe(attacker);
    expect(captured.type).toBe('base');
    expect(captured.stock).toBeLessThan(1);
    expect([...room.world.nodes.values()].filter((n) => n.type === 'hq' && n.ownerId === attacker))
      .toHaveLength(1);

    // And it is wired into the attacker's finished line.
    const linked = [...room.world.edges.values()].some(
      (e) => e.nodeA === victimHq.id || e.nodeB === victimHq.id,
    );
    expect(linked).toBe(true);
  });

  it('cancels constructions belonging to the eliminated player', () => {
    const { room, victim, victimHq, attacker, forward, victimBase } = stageAttack(3);
    const victimAim = towardCentre(victimBase, 150);
    const victimBuild = room.requestBuild(victim, victimBase.id, victimAim.x, victimAim.y, 1_500);
    expect(victimBuild.ok).toBe(true);

    runAttack(room, attacker, forward.id, victimHq.x, victimHq.y);
    expect([...room.constructions.values()].some((c) => c.ownerId === victim)).toBe(false);
  });

  it('emits hqCaptured, playerEliminated and victory events', () => {
    const { room, attacker, victim, victimHq, forward } = stageAttack(2);
    room.drainEvents();
    runAttack(room, attacker, forward.id, victimHq.x, victimHq.y);
    const types = room.drainEvents().map((e) => e.type);

    expect(types).toContain('hqCaptured');
    expect(types).toContain('playerEliminated');
    expect(types).toContain('victory');
    expect(types.indexOf('hqCaptured')).toBeLessThan(types.indexOf('playerEliminated'));
    void victim;
  });

  it('declares the last remaining player the winner', () => {
    const { room, ids } = startedRoom(3);
    room.eliminatePlayer(ids[1], ids[0], 'hq');
    expect(room.status).toBe('playing');
    room.eliminatePlayer(ids[2], ids[0], 'hq');
    expect(room.status).toBe('finished');
    expect(room.winnerId).toBe(ids[0]);
  });
});

describe('lobby rules', () => {
  it('needs at least two players to start', () => {
    const room = new GameRoom({ code: 'AAAA' });
    room.addPlayer('solo', 's1', 0);
    expect(room.start(0).ok).toBe(false);
    room.addPlayer('friend', 's2', 0);
    expect(room.start(0).ok).toBe(true);
    expect(room.status).toBe('playing');
  });

  it('caps the room at six players and gives each a distinct colour', () => {
    const room = new GameRoom({ code: 'AAAA' });
    for (let i = 0; i < MAX_PLAYERS; i++) {
      expect('error' in room.addPlayer(`p${i}`, `s${i}`, 0)).toBe(false);
    }
    const seventh = room.addPlayer('nope', 's7', 0);
    expect('error' in seventh).toBe(true);
    const colors = new Set([...room.players.values()].map((p) => p.color));
    expect(colors.size).toBe(MAX_PLAYERS);
  });

  it('spawns one HQ per player around the map edge', () => {
    const { room, ids } = startedRoom(4);
    const hqs = [...room.world.nodes.values()].filter((n) => n.type === 'hq');
    expect(hqs).toHaveLength(4);
    for (const id of ids) {
      expect(hqs.filter((h) => h.ownerId === id)).toHaveLength(1);
    }
    for (const hq of hqs) {
      expect(hq.x).toBeGreaterThanOrEqual(0);
      expect(hq.x).toBeLessThanOrEqual(1600);
      expect(hq.y).toBeGreaterThanOrEqual(0);
      expect(hq.y).toBeLessThanOrEqual(900);
    }
  });

  it('refuses joins once the match has started', () => {
    const { room } = startedRoom(2);
    expect('error' in room.addPlayer('late', 's9', 0)).toBe(true);
  });

  it('sanitises display names', () => {
    const room = new GameRoom({ code: 'AAAA' });
    const player = room.addPlayer('   ', 's1', 0);
    expect('error' in player).toBe(false);
    expect((player as { name: string }).name).toBe('Player 1');
    const long = room.addPlayer('x'.repeat(50), 's2', 0) as { name: string };
    expect(long.name.length).toBeLessThanOrEqual(16);
  });
});

/** Requirement 16. */
describe('reconnection', () => {
  it('restores control to the correct player', () => {
    const { room, ids } = startedRoom(2);
    const token = room.players.get(ids[1])!.reconnectToken;

    room.markDisconnected(ids[1], 'socket-2', 5_000);
    expect(room.players.get(ids[1])!.connected).toBe(false);

    const restored = room.reconnect(token, 'new-socket', 10_000);
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(ids[1]);
    expect(restored!.socketId).toBe('new-socket');
    expect(room.players.get(ids[1])!.connected).toBe(true);

    // And that player can act again.
    const hq = hqNode(room, ids[1]);
    const aim = towardCentre(hq, 134);
    expect(room.requestBuild(ids[1], hq.id, aim.x, aim.y, 11_000).ok).toBe(true);
  });

  it('rejects an unknown or stale token', () => {
    const { room } = startedRoom(2);
    expect(room.reconnect('not-a-token', 'sock', 1_000)).toBeNull();
  });

  it('does not eliminate a player who returns inside the grace window', () => {
    const { room, ids } = startedRoom(2);
    const token = room.players.get(ids[1])!.reconnectToken;
    room.markDisconnected(ids[1], 'socket-2', 5_000);
    room.tick(5_000 + RECONNECT_GRACE_MS - 1_000);
    expect(room.players.get(ids[1])!.alive).toBe(true);

    room.reconnect(token, 'sock2', 5_000 + RECONNECT_GRACE_MS - 500);
    room.tick(5_000 + RECONNECT_GRACE_MS + 5_000);
    expect(room.players.get(ids[1])!.alive).toBe(true);
    expect(room.status).toBe('playing');
  });

  it('eliminates a player whose reconnect window expires mid-match', () => {
    const { room, ids } = startedRoom(3);
    room.markDisconnected(ids[2], 'socket-3', 5_000);
    room.tick(5_000 + RECONNECT_GRACE_MS + 1);

    expect(room.players.get(ids[2])!.alive).toBe(false);
    expect([...room.world.nodes.values()].some((n) => n.ownerId === ids[2])).toBe(false);
    expect(room.status).toBe('playing'); // two players left
  });

  it('awards victory when the last opponent times out', () => {
    const { room, ids } = startedRoom(2);
    room.markDisconnected(ids[1], 'socket-2', 5_000);
    room.tick(5_000 + RECONNECT_GRACE_MS + 1);
    expect(room.status).toBe('finished');
    expect(room.winnerId).toBe(ids[0]);
  });

  it('drops a lobby player whose window expires before the match', () => {
    const room = new GameRoom({ code: 'AAAA' });
    const a = room.addPlayer('a', 's1', 0) as { id: string };
    const b = room.addPlayer('b', 's2', 0) as { id: string };
    room.markDisconnected(b.id, 's2', 1_000);
    room.tick(1_000 + RECONNECT_GRACE_MS + 1);
    expect(room.players.has(b.id)).toBe(false);
    expect(room.hostId).toBe(a.id);
  });
});

describe('fast transport reconnects', () => {
  it('ignores a late disconnect from a socket the player already left behind', () => {
    const { room, ids } = startedRoom(2);
    const token = room.players.get(ids[1])!.reconnectToken;

    // The player rebinds to a new socket before the old socket's disconnect
    // event is processed.
    room.reconnect(token, 'socket-2b', 1_500);
    room.markDisconnected(ids[1], 'socket-2', 1_600); // stale drop

    expect(room.players.get(ids[1])!.connected).toBe(true);
    expect(room.players.get(ids[1])!.socketId).toBe('socket-2b');

    // And they are not eliminated once the grace window would have passed.
    room.tick(1_600 + RECONNECT_GRACE_MS + 1);
    expect(room.players.get(ids[1])!.alive).toBe(true);
    expect(room.status).toBe('playing');
  });

  it('still honours a drop from the current socket', () => {
    const { room, ids } = startedRoom(2);
    room.markDisconnected(ids[1], 'socket-2', 1_600);
    expect(room.players.get(ids[1])!.connected).toBe(false);
  });
});
