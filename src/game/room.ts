import {
  BUILD_REQUEST_MIN_INTERVAL_MS,
  HQ_INITIAL_STOCK,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLAYER_COLORS,
  RECONNECT_GRACE_MS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  capacityForNodeType,
} from '../shared/config';
import type {
  Construction,
  GameEvent,
  NodeSnapshot,
  PlayerPublic,
  RoomStatus,
  Snapshot,
} from '../shared/types';
import { reachableNodes, sortIds } from './graph';
import { randomToken } from './random';
import { completeLine, connectNodes } from './lines';
import { simulateSupply } from './supply';
import { evaluateBuild, type BuildContext, type BuildEvaluation } from './validate';
import { addNode, createWorld, findHq, removeNode, type World } from './world';

export interface RoomPlayer {
  id: string;
  name: string;
  color: string;
  alive: boolean;
  connected: boolean;
  socketId: string | null;
  reconnectToken: string;
  disconnectedAt: number | null;
  lastBuildRequestAt: number;
}

export interface GameRoomOptions {
  code: string;
  /** Injectable so tests get stable tokens. */
  tokenFactory?: () => string;
}

export interface BuildRequestResult {
  ok: boolean;
  reason: string | null;
  constructionId: string | null;
  evaluation: BuildEvaluation | null;
}

const MAX_TICK_SECONDS = 0.5;

/**
 * One in-memory match. Fully authoritative: every number a client sees was
 * produced here, and every client message is re-validated here.
 */
export class GameRoom {
  readonly code: string;
  readonly world: World = createWorld();

  status: RoomStatus = 'lobby';
  winnerId: string | null = null;
  hostId: string | null = null;

  readonly players = new Map<string, RoomPlayer>();
  readonly constructions = new Map<string, Construction>();

  /** Drained by the server each tick and broadcast as discrete events. */
  private pendingEvents: GameEvent[] = [];
  /** Per-player supply distance from HQ, refreshed every simulation tick. */
  private supplyDistances = new Map<string, Map<string, number>>();

  private playerCounter = 0;
  private constructionCounter = 0;
  private lastTickAt = 0;
  private readonly tokenFactory: () => string;

  lastActivityAt = 0;

  constructor(options: GameRoomOptions) {
    this.code = options.code;
    this.tokenFactory = options.tokenFactory ?? randomToken;
  }

  // ---------------------------------------------------------------- lobby

  addPlayer(rawName: string, socketId: string | null, now: number): RoomPlayer | { error: string } {
    if (this.status !== 'lobby') return { error: 'match already started' };
    if (this.players.size >= MAX_PLAYERS) return { error: `room is full (${MAX_PLAYERS} players)` };

    const name = sanitizeName(rawName, this.players.size + 1);
    const id = `p${++this.playerCounter}`;
    const color = PLAYER_COLORS[this.players.size % PLAYER_COLORS.length] as string;

    const player: RoomPlayer = {
      id,
      name,
      color,
      alive: true,
      connected: socketId !== null,
      socketId,
      reconnectToken: this.tokenFactory(),
      disconnectedAt: null,
      lastBuildRequestAt: 0,
    };
    this.players.set(id, player);
    if (this.hostId === null) this.hostId = id;
    this.lastActivityAt = now;
    this.emit({ type: 'playerJoined', playerId: id, name });
    return player;
  }

  removePlayer(playerId: string, now: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    this.cancelConstructionsOf(playerId, 'player left');
    for (const node of [...this.world.nodes.values()]) {
      if (node.ownerId === playerId) removeNode(this.world, node.id);
    }
    this.emit({ type: 'playerLeft', playerId, name: player.name });
    if (this.hostId === playerId) {
      this.hostId = this.players.keys().next().value ?? null;
    }
    this.lastActivityAt = now;
    if (this.status === 'playing') this.checkVictory();
  }

  playerByToken(token: string): RoomPlayer | undefined {
    for (const player of this.players.values()) {
      if (player.reconnectToken === token) return player;
    }
    return undefined;
  }

  /**
   * Mark a player offline because `socketId` dropped.
   *
   * On a fast transport reconnect the old socket's disconnect can arrive after
   * the new socket has already rebound the player, so a drop is only honoured
   * when it comes from the socket the player is currently bound to.
   */
  markDisconnected(playerId: string, socketId: string | null, now: number): void {
    const player = this.players.get(playerId);
    if (!player || !player.connected) return;
    if (socketId !== null && player.socketId !== null && player.socketId !== socketId) return;
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = now;
    this.emit({ type: 'playerDisconnected', playerId, name: player.name });
  }

  /** Rebind a returning player to a new socket. Returns the player on success. */
  reconnect(token: string, socketId: string, now: number): RoomPlayer | null {
    const player = this.playerByToken(token);
    if (!player) return null;
    player.connected = true;
    player.socketId = socketId;
    player.disconnectedAt = null;
    this.lastActivityAt = now;
    this.emit({ type: 'playerReconnected', playerId: player.id, name: player.name });
    return player;
  }

  canStart(): { ok: boolean; reason: string | null } {
    if (this.status !== 'lobby') return { ok: false, reason: 'match already started' };
    if (this.players.size < MIN_PLAYERS) {
      return { ok: false, reason: `need at least ${MIN_PLAYERS} players` };
    }
    return { ok: true, reason: null };
  }

  start(now: number): { ok: boolean; reason: string | null } {
    const check = this.canStart();
    if (!check.ok) return check;

    const ids = [...this.players.keys()];
    const count = ids.length;
    const cx = WORLD_WIDTH / 2;
    const cy = WORLD_HEIGHT / 2;
    const rx = WORLD_WIDTH * 0.39;
    const ry = WORLD_HEIGHT * 0.37;

    // Start on the long axis. Anchoring at -90 degrees put a 2-player match on
    // the map's short side, leaving the HQs only ~666px apart - two builds and
    // the game was over before anyone could react.
    ids.forEach((id, index) => {
      const angle = (index * 2 * Math.PI) / count;
      const x = Math.round(cx + rx * Math.cos(angle));
      const y = Math.round(cy + ry * Math.sin(angle));
      addNode(this.world, id, 'hq', x, y, HQ_INITIAL_STOCK);
    });

    this.status = 'playing';
    this.lastTickAt = now;
    this.lastActivityAt = now;
    this.emit({ type: 'matchStarted' });
    return { ok: true, reason: null };
  }

  // ----------------------------------------------------------- simulation

  tick(now: number): void {
    this.processReconnectTimeouts(now);
    if (this.status !== 'playing') {
      this.lastTickAt = now;
      return;
    }

    const dt = Math.max(0, Math.min(MAX_TICK_SECONDS, (now - this.lastTickAt) / 1000));
    this.lastTickAt = now;

    this.completeDueConstructions(now);

    const players = [...this.players.values()].map((p) => ({ id: p.id, alive: p.alive }));
    const result = simulateSupply(this.world, players, dt);
    this.supplyDistances = result.distances;

    this.checkVictory();
  }

  private processReconnectTimeouts(now: number): void {
    for (const player of [...this.players.values()]) {
      if (player.connected || player.disconnectedAt === null) continue;
      if (now - player.disconnectedAt < RECONNECT_GRACE_MS) continue;

      player.disconnectedAt = null;
      if (this.status === 'playing' && player.alive) {
        this.eliminatePlayer(player.id, null, 'disconnect');
      } else if (this.status === 'lobby') {
        this.removePlayer(player.id, now);
      }
    }
  }

  private completeDueConstructions(now: number): void {
    const due = [...this.constructions.values()]
      .filter((c) => c.finishTime <= now)
      .sort((a, b) => {
        if (a.finishTime !== b.finishTime) return a.finishTime - b.finishTime;
        return sortIds([a.id, b.id])[0] === a.id ? -1 : 1;
      });

    for (const construction of due) {
      if (!this.constructions.has(construction.id)) continue; // cancelled meanwhile
      this.constructions.delete(construction.id);
      this.applyConstruction(construction, now);
    }
  }

  private applyConstruction(construction: Construction, now: number): void {
    const owner = this.players.get(construction.ownerId);
    if (!owner || !owner.alive) return;

    const report = completeLine(this.world, {
      ownerId: construction.ownerId,
      sourceNodeId: construction.sourceNodeId,
      targetX: construction.targetX,
      targetY: construction.targetY,
      hqOf: (playerId) => findHq(this.world, playerId)?.id ?? null,
      alivePlayerIds: this.alivePlayerIds(),
    });

    if (!report.ok) {
      this.emit({
        type: 'constructionCancelled',
        constructionId: construction.id,
        playerId: construction.ownerId,
        reason: report.reason ?? 'invalid',
      });
      return;
    }

    this.emit({
      type: 'constructionCompleted',
      constructionId: construction.id,
      playerId: construction.ownerId,
    });

    for (const cut of report.cuts) {
      this.emit({
        type: 'supplyLineCut',
        attackerId: construction.ownerId,
        victimId: cut.victimId,
        edgeId: cut.edgeId,
        x: cut.x,
        y: cut.y,
      });
    }

    for (const capture of report.captures) {
      // A captured source cannot keep building for its old owner.
      for (const active of [...this.constructions.values()]) {
        if (capture.nodeIds.includes(active.sourceNodeId)) {
          this.cancelConstruction(active.id, 'source captured');
        }
      }
      this.emit({
        type: 'networkCaptured',
        attackerId: construction.ownerId,
        victimId: capture.victimId,
        nodeIds: capture.nodeIds,
        edgeIds: capture.edgeIds,
      });
    }

    if (report.hqCapture) {
      const { victimId, hqNodeId, fromNodeId } = report.hqCapture;
      this.emit({ type: 'hqCaptured', attackerId: construction.ownerId, victimId });
      this.eliminatePlayer(victimId, construction.ownerId, 'hq');
      // The captured HQ is now an ordinary base of the attacker; wire the
      // finished line into it.
      connectNodes(this.world, construction.ownerId, fromNodeId, hqNodeId);
    }

    this.lastActivityAt = now;
  }

  // ------------------------------------------------------------ building

  requestBuild(
    playerId: string,
    fromNodeId: unknown,
    targetX: unknown,
    targetY: unknown,
    now: number,
  ): BuildRequestResult {
    const player = this.players.get(playerId);
    if (!player) return reject('unknown player');
    if (this.status !== 'playing') return reject('match is not running');

    if (now - player.lastBuildRequestAt < BUILD_REQUEST_MIN_INTERVAL_MS) {
      player.lastBuildRequestAt = now;
      return reject('slow down');
    }
    player.lastBuildRequestAt = now;

    const evaluation = evaluateBuild(this.buildContext(playerId), fromNodeId, targetX, targetY);
    if (!evaluation.ok || !evaluation.target) {
      return { ok: false, reason: evaluation.reason, constructionId: null, evaluation };
    }

    const source = this.world.nodes.get(fromNodeId as string);
    if (!source) return reject('source node does not exist');

    // Cost is deducted immediately from the source node.
    source.stock = Math.max(0, source.stock - evaluation.cost);

    const construction: Construction = {
      id: `c${++this.constructionCounter}`,
      ownerId: playerId,
      sourceNodeId: source.id,
      targetX: evaluation.target.x,
      targetY: evaluation.target.y,
      targetNodeId: evaluation.target.node?.id ?? null,
      startTime: now,
      finishTime: now + evaluation.buildTime * 1000,
      cost: evaluation.cost,
      distance: evaluation.distance,
    };
    this.constructions.set(construction.id, construction);
    this.lastActivityAt = now;

    this.emit({
      type: 'constructionStarted',
      constructionId: construction.id,
      playerId,
      sourceNodeId: source.id,
      x: construction.targetX,
      y: construction.targetY,
    });

    return { ok: true, reason: null, constructionId: construction.id, evaluation };
  }

  buildContext(playerId: string): BuildContext {
    const player = this.players.get(playerId);
    const connected = this.connectedNodeIds(playerId);
    return {
      playerId,
      alive: player?.alive ?? false,
      nodes: this.world.nodes.values(),
      getNode: (id) => this.world.nodes.get(id),
      isConnectedToHq: (nodeId) => connected.has(nodeId),
      activeConstructionsForPlayer: [...this.constructions.values()].filter(
        (c) => c.ownerId === playerId,
      ).length,
      activeConstructionsOnNode: (nodeId) =>
        [...this.constructions.values()].filter((c) => c.sourceNodeId === nodeId).length,
      alivePlayerIds: this.alivePlayerIds(),
    };
  }

  /** Fresh connectivity (not the cached tick result) for validation. */
  connectedNodeIds(playerId: string): Set<string> {
    const hq = findHq(this.world, playerId);
    if (!hq) return new Set();
    return reachableNodes(this.world, playerId, hq.id);
  }

  cancelConstruction(constructionId: string, reason: string): void {
    const construction = this.constructions.get(constructionId);
    if (!construction) return;
    this.constructions.delete(constructionId);
    this.emit({
      type: 'constructionCancelled',
      constructionId,
      playerId: construction.ownerId,
      reason,
    });
  }

  private cancelConstructionsOf(playerId: string, reason: string): void {
    for (const construction of [...this.constructions.values()]) {
      if (construction.ownerId === playerId) this.cancelConstruction(construction.id, reason);
    }
  }

  // --------------------------------------------------------- elimination

  /**
   * Remove a player from play. With an attacker, every asset transfers to them
   * (stocks reset, the captured HQ demotes to a base so nobody ends up with two
   * producing HQs). Without one (disconnect timeout) the assets are removed.
   */
  eliminatePlayer(playerId: string, attackerId: string | null, reason: 'hq' | 'disconnect'): void {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    player.alive = false;

    this.cancelConstructionsOf(playerId, 'eliminated');

    if (attackerId && this.players.get(attackerId)?.alive) {
      for (const node of this.world.nodes.values()) {
        if (node.ownerId !== playerId) continue;
        node.ownerId = attackerId;
        node.stock = 0;
        if (node.type === 'hq') node.type = 'base';
      }
      for (const edge of this.world.edges.values()) {
        if (edge.ownerId === playerId) edge.ownerId = attackerId;
      }
    } else {
      for (const node of [...this.world.nodes.values()]) {
        if (node.ownerId === playerId) removeNode(this.world, node.id);
      }
      for (const [id, edge] of [...this.world.edges]) {
        if (edge.ownerId === playerId) this.world.edges.delete(id);
      }
    }

    this.emit({ type: 'playerEliminated', playerId, reason });
    this.checkVictory();
  }

  private checkVictory(): void {
    if (this.status !== 'playing') return;
    const alive = [...this.players.values()].filter((p) => p.alive);
    if (alive.length > 1) return;
    this.status = 'finished';
    this.winnerId = alive[0]?.id ?? null;
    this.emit({ type: 'victory', winnerId: this.winnerId });
  }

  // -------------------------------------------------------------- output

  alivePlayerIds(): ReadonlySet<string> {
    const set = new Set<string>();
    for (const player of this.players.values()) if (player.alive) set.add(player.id);
    return set;
  }

  emit(event: GameEvent): void {
    this.pendingEvents.push(event);
  }

  drainEvents(): GameEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  publicPlayers(): PlayerPublic[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      alive: p.alive,
      connected: p.connected,
      isHost: p.id === this.hostId,
    }));
  }

  snapshot(now: number): Snapshot {
    const nodes: NodeSnapshot[] = [];
    for (const node of this.world.nodes.values()) {
      const distances = this.supplyDistances.get(node.ownerId);
      const connected =
        node.type === 'hq'
          ? true
          : distances
            ? distances.has(node.id)
            : this.connectedNodeIds(node.ownerId).has(node.id);
      nodes.push({
        ...node,
        stock: Math.round(node.stock * 10) / 10,
        connected,
        capacity: capacityForNodeType(node.type),
      });
    }

    return {
      roomCode: this.code,
      status: this.status,
      serverTime: now,
      players: this.publicPlayers(),
      nodes,
      edges: [...this.world.edges.values()],
      constructions: [...this.constructions.values()],
      winnerId: this.winnerId,
      hostId: this.hostId,
    };
  }
}

function reject(reason: string): BuildRequestResult {
  return { ok: false, reason, constructionId: null, evaluation: null };
}

export function sanitizeName(rawName: unknown, index: number): string {
  if (typeof rawName !== 'string') return `Player ${index}`;
  let cleaned = '';
  for (const ch of rawName) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) cleaned += ch;
  }
  cleaned = cleaned.trim().slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : `Player ${index}`;
}
