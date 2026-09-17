import { GameRoom } from '../game/room';
import { SNAPSHOT_INTERVAL_MS } from '../shared/config';
import type { GuestToHost, HostToGuest } from './protocol';

/**
 * One connected guest, from the host's point of view. Abstract so the session
 * can be unit tested without any WebRTC.
 */
export interface HostClient {
  id: string;
  send(message: HostToGuest): void;
  close(): void;
}

/**
 * The authoritative game, running inside the host player's browser.
 *
 * Everything arriving through `receive` came from another person's machine and
 * is treated exactly like a client message on the real server: parsed
 * defensively, then handed to GameRoom which does the actual validation.
 *
 * The host player is itself a client (conventionally id "local") whose `send`
 * delivers straight to the local UI, so there is a single code path for
 * everyone.
 */
export class HostSession {
  readonly room: GameRoom;

  private readonly clients = new Map<string, HostClient>();
  private readonly playerByClient = new Map<string, string>();
  private readonly clientByPlayer = new Map<string, string>();
  private sinceSnapshot = 0;

  constructor(code: string) {
    this.room = new GameRoom({ code });
  }

  addClient(client: HostClient): void {
    this.clients.set(client.id, client);
  }

  /** A guest's data channel closed. Start their reconnect window. */
  dropClient(clientId: string, now: number): void {
    this.clients.delete(clientId);
    const playerId = this.playerByClient.get(clientId);
    if (playerId === undefined) return;
    this.playerByClient.delete(clientId);
    if (this.clientByPlayer.get(playerId) === clientId) this.clientByPlayer.delete(playerId);

    if (this.room.status === 'lobby') {
      this.room.removePlayer(playerId, now);
    } else {
      this.room.markDisconnected(playerId, clientId, now);
    }
    this.broadcastLobby();
    this.flushEvents();
  }

  receive(clientId: string, raw: unknown, now: number): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    const message = parseGuestMessage(raw);
    if (!message) return;

    switch (message.t) {
      case 'hello':
        this.handleHello(client, message.name, now);
        break;
      case 'resume':
        this.handleResume(client, message.token, now);
        break;
      case 'start':
        this.handleStart(client, now);
        break;
      case 'build':
        this.handleBuild(client, message, now);
        break;
      case 'bye': {
        const playerId = this.playerByClient.get(clientId);
        if (playerId !== undefined) this.room.removePlayer(playerId, now);
        this.dropClient(clientId, now);
        break;
      }
    }
  }

  private handleHello(client: HostClient, name: string, now: number): void {
    if (this.playerByClient.has(client.id)) return; // already seated
    const result = this.room.addPlayer(name, client.id, now);
    if ('error' in result) {
      client.send({ t: 'err', message: result.error });
      client.send({ t: 'kick', message: result.error });
      return;
    }
    this.seat(client.id, result.id);
    client.send({
      t: 'joined',
      roomCode: this.room.code,
      playerId: result.id,
      reconnectToken: result.reconnectToken,
      status: this.room.status,
    });
    this.broadcastLobby();
    this.flushEvents();
  }

  private handleResume(client: HostClient, token: string, now: number): void {
    const player = this.room.reconnect(token, client.id, now);
    if (!player) {
      client.send({ t: 'kick', message: 'reconnect window expired' });
      return;
    }
    this.seat(client.id, player.id);
    client.send({
      t: 'joined',
      roomCode: this.room.code,
      playerId: player.id,
      reconnectToken: player.reconnectToken,
      status: this.room.status,
    });
    client.send({ t: 'snap', snapshot: this.room.snapshot(now) });
    this.broadcastLobby();
    this.flushEvents();
  }

  private handleStart(client: HostClient, now: number): void {
    const playerId = this.playerByClient.get(client.id);
    if (playerId === undefined) return;
    if (this.room.hostId !== playerId) {
      client.send({ t: 'err', message: 'only the host can start the match' });
      return;
    }
    const result = this.room.start(now);
    if (!result.ok) {
      client.send({ t: 'err', message: result.reason ?? 'cannot start' });
      return;
    }
    this.broadcastLobby();
    this.flushEvents();
  }

  private handleBuild(
    client: HostClient,
    message: Extract<GuestToHost, { t: 'build' }>,
    now: number,
  ): void {
    const playerId = this.playerByClient.get(client.id);
    if (playerId === undefined) return;
    const result = this.room.requestBuild(
      playerId,
      message.fromNodeId,
      message.targetX,
      message.targetY,
      now,
    );
    if (!result.ok && result.reason && result.reason !== 'slow down') {
      client.send({ t: 'err', message: result.reason });
    }
    this.flushEvents();
  }

  private seat(clientId: string, playerId: string): void {
    const previous = this.clientByPlayer.get(playerId);
    if (previous !== undefined && previous !== clientId) this.playerByClient.delete(previous);
    this.playerByClient.set(clientId, playerId);
    this.clientByPlayer.set(playerId, clientId);
  }

  /** Advance the simulation. Call at the normal tick rate. */
  tick(now: number, deltaMs: number): void {
    const statusBefore = this.room.status;
    this.room.tick(now);
    this.flushEvents();

    this.sinceSnapshot += deltaMs;
    if (this.sinceSnapshot >= SNAPSHOT_INTERVAL_MS) {
      this.sinceSnapshot = 0;
      this.broadcast({ t: 'snap', snapshot: this.room.snapshot(now) });
    }
    if (statusBefore !== this.room.status) this.broadcastLobby();
  }

  broadcastLobby(): void {
    this.broadcast({
      t: 'lobby',
      roomCode: this.room.code,
      hostId: this.room.hostId,
      status: this.room.status,
      players: this.room.publicPlayers(),
    });
  }

  private flushEvents(): void {
    const events = this.room.drainEvents();
    if (events.length > 0) this.broadcast({ t: 'events', events });
  }

  broadcast(message: HostToGuest): void {
    for (const client of this.clients.values()) client.send(message);
  }

  dispose(): void {
    for (const client of this.clients.values()) {
      client.send({ t: 'kick', message: 'the host left the game' });
      client.close();
    }
    this.clients.clear();
    this.playerByClient.clear();
    this.clientByPlayer.clear();
  }
}

/** Defensive parse: this data came from someone else's browser. */
export function parseGuestMessage(raw: unknown): GuestToHost | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const message = raw as Record<string, unknown>;
  switch (message.t) {
    case 'hello':
      return { t: 'hello', name: typeof message.name === 'string' ? message.name : '' };
    case 'resume':
      return typeof message.token === 'string' && message.token.length <= 128
        ? { t: 'resume', token: message.token }
        : null;
    case 'start':
      return { t: 'start' };
    case 'bye':
      return { t: 'bye' };
    case 'build':
      // Values stay unknown on purpose: GameRoom re-validates types and ranges.
      return {
        t: 'build',
        fromNodeId: message.fromNodeId,
        targetX: message.targetX,
        targetY: message.targetY,
      };
    default:
      return null;
  }
}
