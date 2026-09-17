import { describe, expect, it } from 'vitest';
import { HostSession, parseGuestMessage, type HostClient } from '../src/p2p/host';
import type { HostToGuest } from '../src/p2p/protocol';
import { RECONNECT_GRACE_MS, TICK_INTERVAL_MS } from '../src/shared/config';

/** A fake data channel that just records what the host sent. */
function fakeClient(id: string) {
  const inbox: HostToGuest[] = [];
  let closed = false;
  const client: HostClient = {
    id,
    send: (m) => inbox.push(m),
    close: () => { closed = true; },
  };
  return {
    client,
    inbox,
    isClosed: () => closed,
    last: <T extends HostToGuest['t']>(t: T) =>
      [...inbox].reverse().find((m) => m.t === t) as Extract<HostToGuest, { t: T }> | undefined,
  };
}

function lobbyOf(code = 'TEST') {
  const session = new HostSession(code);
  const host = fakeClient('local');
  const guest = fakeClient('peer-1');
  session.addClient(host.client);
  session.addClient(guest.client);
  session.receive('local', { t: 'hello', name: 'Host' }, 1_000);
  session.receive('peer-1', { t: 'hello', name: 'Guest' }, 1_100);
  return { session, host, guest };
}

describe('P2P host session', () => {
  it('seats the host first so they own the room', () => {
    const { session, host, guest } = lobbyOf();
    expect(host.last('joined')?.playerId).toBe('p1');
    expect(guest.last('joined')?.playerId).toBe('p2');
    expect(session.room.hostId).toBe('p1');
    expect(host.last('lobby')?.players.map((p) => p.name)).toEqual(['Host', 'Guest']);
  });

  it('gives each player a distinct reconnect token', () => {
    const { host, guest } = lobbyOf();
    const a = host.last('joined')!.reconnectToken;
    const b = guest.last('joined')!.reconnectToken;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('refuses to let a guest start the match', () => {
    const { session, guest } = lobbyOf();
    session.receive('peer-1', { t: 'start' }, 2_000);
    expect(guest.last('err')?.message).toBe('only the host can start the match');
    expect(session.room.status).toBe('lobby');
  });

  it('lets the host start, and broadcasts the new status', () => {
    const { session, host, guest } = lobbyOf();
    session.receive('local', { t: 'start' }, 2_000);
    expect(session.room.status).toBe('playing');
    expect(host.last('lobby')?.status).toBe('playing');
    expect(guest.last('lobby')?.status).toBe('playing');
  });

  it('validates guest build requests through the authoritative room', () => {
    const { session, guest } = lobbyOf();
    session.receive('local', { t: 'start' }, 2_000);

    const enemyHq = [...session.room.world.nodes.values()].find((n) => n.ownerId === 'p1')!;
    // A guest trying to build from a node they do not own.
    session.receive('peer-1', {
      t: 'build', fromNodeId: enemyHq.id, targetX: enemyHq.x + 100, targetY: enemyHq.y,
    }, 2_500);
    expect(guest.last('err')?.message).toBe('source node is not yours');

    // Garbage coordinates.
    session.receive('peer-1', {
      t: 'build', fromNodeId: enemyHq.id, targetX: 'boom', targetY: null,
    }, 3_000);
    expect(guest.last('err')?.message).toBe('invalid target coordinates');

    // A legal build from their own HQ.
    const ownHq = [...session.room.world.nodes.values()].find((n) => n.ownerId === 'p2')!;
    session.receive('peer-1', {
      t: 'build', fromNodeId: ownHq.id, targetX: ownHq.x, targetY: ownHq.y - 150,
    }, 3_500);
    expect(session.room.constructions.size).toBe(1);
  });

  it('ignores messages from clients that never said hello', () => {
    const { session } = lobbyOf();
    const stranger = fakeClient('peer-9');
    session.addClient(stranger.client);
    session.receive('peer-9', { t: 'start' }, 2_000);
    expect(session.room.status).toBe('lobby');
    session.receive('peer-9', { t: 'build', fromNodeId: 'n1', targetX: 1, targetY: 1 }, 2_100);
    expect(session.room.constructions.size).toBe(0);
  });

  it('ignores malformed messages instead of throwing', () => {
    const { session } = lobbyOf();
    for (const junk of [null, undefined, 42, 'hello', [], { t: 'nope' }, { t: 'resume' }]) {
      expect(() => session.receive('peer-1', junk, 2_000)).not.toThrow();
    }
    expect(session.room.players.size).toBe(2);
  });

  it('broadcasts snapshots at the snapshot rate, not every tick', () => {
    const { session, guest } = lobbyOf();
    session.receive('local', { t: 'start' }, 2_000);
    guest.inbox.length = 0;

    let now = 2_000;
    for (let i = 0; i < 4; i++) {
      now += TICK_INTERVAL_MS;
      session.tick(now, TICK_INTERVAL_MS);
    }
    const snaps = guest.inbox.filter((m) => m.t === 'snap').length;
    expect(snaps).toBe(2); // 4 ticks at 20Hz -> 2 snapshots at 10Hz
  });

  it('removes a guest who drops while still in the lobby', () => {
    const { session } = lobbyOf();
    session.dropClient('peer-1', 2_000);
    expect(session.room.players.size).toBe(1);
  });

  it('starts a reconnect window when a guest drops mid-match', () => {
    const { session } = lobbyOf();
    session.receive('local', { t: 'start' }, 2_000);
    session.dropClient('peer-1', 2_500);

    expect(session.room.players.get('p2')!.connected).toBe(false);
    expect(session.room.players.get('p2')!.alive).toBe(true);
  });

  it('restores a returning guest on a brand new connection', () => {
    const { session, guest } = lobbyOf();
    const token = guest.last('joined')!.reconnectToken;
    session.receive('local', { t: 'start' }, 2_000);
    session.dropClient('peer-1', 2_500);

    // WebRTC gives the returning player a different peer id.
    const returning = fakeClient('peer-1b');
    session.addClient(returning.client);
    session.receive('peer-1b', { t: 'resume', token }, 3_000);

    expect(returning.last('joined')?.playerId).toBe('p2');
    expect(returning.last('snap')).toBeDefined();
    expect(session.room.players.get('p2')!.connected).toBe(true);

    // And they can act again.
    const ownHq = [...session.room.world.nodes.values()].find((n) => n.ownerId === 'p2')!;
    session.receive('peer-1b', {
      t: 'build', fromNodeId: ownHq.id, targetX: ownHq.x, targetY: ownHq.y - 150,
    }, 3_500);
    expect(session.room.constructions.size).toBe(1);
  });

  it('rejects a bogus resume token', () => {
    const { session } = lobbyOf();
    const stranger = fakeClient('peer-7');
    session.addClient(stranger.client);
    session.receive('peer-7', { t: 'resume', token: 'not-a-real-token' }, 3_000);
    expect(stranger.last('kick')?.message).toBe('reconnect window expired');
  });

  it('eliminates a guest whose reconnect window expires', () => {
    const { session } = lobbyOf();
    session.receive('local', { t: 'start' }, 2_000);
    session.dropClient('peer-1', 2_500);
    session.tick(2_500 + RECONNECT_GRACE_MS + 1, TICK_INTERVAL_MS);

    expect(session.room.players.get('p2')!.alive).toBe(false);
    expect(session.room.status).toBe('finished');
    expect(session.room.winnerId).toBe('p1');
  });

  it('tells everyone and closes the channels when the host leaves', () => {
    const { session, guest } = lobbyOf();
    session.dispose();
    expect(guest.last('kick')?.message).toBe('the host left the game');
    expect(guest.isClosed()).toBe(true);
  });

  it('turns away a guest arriving after the match started', () => {
    const { session } = lobbyOf();
    session.receive('local', { t: 'start' }, 2_000);
    const late = fakeClient('peer-late');
    session.addClient(late.client);
    session.receive('peer-late', { t: 'hello', name: 'Late' }, 2_100);
    expect(late.last('kick')?.message).toBe('match already started');
  });
});

describe('parseGuestMessage', () => {
  it('keeps build payload values unknown for the room to validate', () => {
    const parsed = parseGuestMessage({ t: 'build', fromNodeId: 1, targetX: {}, targetY: 'x' });
    expect(parsed).toEqual({ t: 'build', fromNodeId: 1, targetX: {}, targetY: 'x' });
  });

  it('rejects unknown and malformed messages', () => {
    expect(parseGuestMessage({ t: 'evil' })).toBeNull();
    expect(parseGuestMessage('start')).toBeNull();
    expect(parseGuestMessage(null)).toBeNull();
    expect(parseGuestMessage({ t: 'resume', token: 'x'.repeat(500) })).toBeNull();
  });

  it('coerces a missing name rather than trusting it', () => {
    expect(parseGuestMessage({ t: 'hello' })).toEqual({ t: 'hello', name: '' });
    expect(parseGuestMessage({ t: 'hello', name: 42 })).toEqual({ t: 'hello', name: '' });
  });
});
