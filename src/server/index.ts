import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  SNAPSHOT_INTERVAL_MS,
  TICK_INTERVAL_MS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '../shared/config';
import { C2S, S2C } from '../shared/protocol';
import { diffSnapshot } from '../shared/delta';
import type { Snapshot } from '../shared/types';
import type { GameRoom } from '../game/room';
import { RoomManager, normalizeCode } from './rooms';

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const HOST = '0.0.0.0';

/**
 * Origins allowed to connect when the client is hosted somewhere else
 * (GitHub Pages, Vercel, ...). Comma-separated, e.g.
 *   ALLOWED_ORIGINS=https://me.github.io,https://my-game.vercel.app
 * Unset means same-origin only, which needs no CORS at all. "*" allows any
 * origin - convenient for a throwaway game server, but it does mean any page
 * can open rooms on yours.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const ALLOW_ANY_ORIGIN = ALLOWED_ORIGINS.includes('*');

/**
 * Is this handshake allowed to open a socket?
 *
 * Note that the `cors` option below only affects HTTP polling: browsers do not
 * apply CORS to WebSocket, so an allowlist enforced only through `cors` would
 * be trivially bypassed by any page connecting over WebSocket directly. This
 * check runs for every transport, which is what actually enforces the list.
 *
 * A missing Origin header means a non-browser client (curl, a test script). It
 * is allowed: any such client can spoof the header anyway, and the point of the
 * list is to stop other *websites* from driving your server.
 */
function isOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (ALLOWED_ORIGINS.length === 0 || ALLOW_ANY_ORIGIN) return true;
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Always permit the client this very server is hosting.
  return host !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  serveClient: false,
  pingInterval: 10_000,
  pingTimeout: 8_000,
  allowRequest: (req, callback) => {
    const allowed = isOriginAllowed(req.headers.origin, req.headers.host);
    if (!allowed) log(`rejected connection from origin ${req.headers.origin}`);
    callback(null, allowed);
  },
  ...(ALLOWED_ORIGINS.length > 0
    ? { cors: { origin: ALLOW_ANY_ORIGIN ? true : ALLOWED_ORIGINS } }
    : {}),
});

const rooms = new RoomManager();

/**
 * What each room last broadcast, so the next one can carry only the changes.
 * A keyframe goes out periodically, and whenever someone joins or reconnects,
 * so a client can never be stranded applying deltas onto a view it never had.
 */
const lastBroadcast = new Map<string, Snapshot>();
const KEYFRAME_EVERY = 50; // broadcasts, i.e. every 5 seconds at 10Hz
const sinceKeyframe = new Map<string, number>();

function broadcastSnapshot(room: GameRoom, now: number): void {
  const snapshot = room.snapshot(now);
  const ticks = (sinceKeyframe.get(room.code) ?? KEYFRAME_EVERY) + 1;
  const keyframe = ticks >= KEYFRAME_EVERY;
  sinceKeyframe.set(room.code, keyframe ? 0 : ticks);

  const previous = keyframe ? null : lastBroadcast.get(room.code) ?? null;
  io.to(room.code).emit(S2C.snapshot, diffSnapshot(previous, snapshot));
  lastBroadcast.set(room.code, snapshot);
}

/** Make the next broadcast a keyframe, for a client that has no view yet. */
function requestKeyframe(room: GameRoom): void {
  sinceKeyframe.set(room.code, KEYFRAME_EVERY);
}

/** socket.id -> where that socket currently sits. */
interface Session {
  roomCode: string;
  playerId: string;
}
const sessions = new Map<string, Session>();

// ----------------------------------------------------------------- static

/**
 * npm scripts always run from the package root, so the built client is resolved
 * relative to the working directory. That works identically under `tsx` in dev
 * (ESM) and under the compiled CommonJS output.
 */
const clientDist = path.resolve(process.cwd(), 'dist/client');
const hasClientBuild = fs.existsSync(path.join(clientDist, 'index.html'));
if (hasClientBuild) {
  app.use(express.static(clientDist));
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
});

if (hasClientBuild) {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// ------------------------------------------------------------- socket API

function sendError(socket: Socket, message: string): void {
  socket.emit(S2C.error, { message });
}

function lobbyPayload(room: GameRoom) {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    status: room.status,
    players: room.publicPlayers(),
  };
}

function broadcastLobby(room: GameRoom): void {
  io.to(room.code).emit(S2C.lobby, lobbyPayload(room));
}

function joinSocketToRoom(socket: Socket, room: GameRoom, playerId: string): void {
  sessions.set(socket.id, { roomCode: room.code, playerId });
  void socket.join(room.code);
}

function sessionRoom(socket: Socket): { room: GameRoom; playerId: string } | null {
  const session = sessions.get(socket.id);
  if (!session) return null;
  const room = rooms.get(session.roomCode);
  if (!room) {
    sessions.delete(socket.id);
    return null;
  }
  return { room, playerId: session.playerId };
}

io.on('connection', (socket) => {
  socket.on(C2S.createRoom, (payload: unknown) => {
    const name = readString(payload, 'name');
    const now = Date.now();
    const room = rooms.create(now);
    const result = room.addPlayer(name, socket.id, now);
    if ('error' in result) {
      rooms.delete(room.code);
      sendError(socket, result.error);
      return;
    }
    joinSocketToRoom(socket, room, result.id);
    socket.emit(S2C.roomJoined, {
      roomCode: room.code,
      playerId: result.id,
      reconnectToken: result.reconnectToken,
      status: room.status,
    });
    requestKeyframe(room);
    broadcastLobby(room);
    log(`room ${room.code} created by ${result.name}`);
  });

  socket.on(C2S.joinRoom, (payload: unknown) => {
    const code = normalizeCode(readString(payload, 'code'));
    const name = readString(payload, 'name');
    const room = rooms.get(code);
    if (!room) {
      sendError(socket, `no room with code ${code || '(empty)'}`);
      return;
    }
    if (room.status !== 'lobby') {
      sendError(socket, 'that match has already started');
      return;
    }
    const now = Date.now();
    const result = room.addPlayer(name, socket.id, now);
    if ('error' in result) {
      sendError(socket, result.error);
      return;
    }
    joinSocketToRoom(socket, room, result.id);
    socket.emit(S2C.roomJoined, {
      roomCode: room.code,
      playerId: result.id,
      reconnectToken: result.reconnectToken,
      status: room.status,
    });
    requestKeyframe(room);
    broadcastLobby(room);
    flushEvents(room);
    log(`${result.name} joined room ${room.code} (${room.players.size}/${MAX_PLAYERS})`);
  });

  socket.on(C2S.reconnect, (payload: unknown) => {
    const code = normalizeCode(readString(payload, 'roomCode'));
    const token = readString(payload, 'token');
    const room = rooms.get(code);
    if (!room || token.length === 0) {
      sendError(socket, 'reconnect window expired');
      socket.emit(S2C.kicked, { message: 'reconnect failed' });
      return;
    }
    const now = Date.now();
    const player = room.reconnect(token, socket.id, now);
    if (!player) {
      sendError(socket, 'reconnect window expired');
      socket.emit(S2C.kicked, { message: 'reconnect failed' });
      return;
    }
    joinSocketToRoom(socket, room, player.id);
    socket.emit(S2C.roomJoined, {
      roomCode: room.code,
      playerId: player.id,
      reconnectToken: player.reconnectToken,
      status: room.status,
    });
    socket.emit(S2C.snapshot, { ...room.snapshot(now), full: true });
    requestKeyframe(room);
    broadcastLobby(room);
    flushEvents(room);
    log(`${player.name} reconnected to room ${room.code}`);
  });

  socket.on(C2S.startGame, () => {
    const found = sessionRoom(socket);
    if (!found) return;
    const { room, playerId } = found;
    if (room.hostId !== playerId) {
      sendError(socket, 'only the host can start the match');
      return;
    }
    const result = room.start(Date.now());
    if (!result.ok) {
      sendError(socket, result.reason ?? `need at least ${MIN_PLAYERS} players`);
      return;
    }
    broadcastLobby(room);
    flushEvents(room);
    log(`room ${room.code} started with ${room.players.size} players`);
  });

  socket.on(C2S.buildLine, (payload: unknown) => {
    const found = sessionRoom(socket);
    if (!found) return;
    const { room, playerId } = found;
    const result = room.requestBuild(
      playerId,
      readRaw(payload, 'fromNodeId'),
      readRaw(payload, 'targetX'),
      readRaw(payload, 'targetY'),
      Date.now(),
    );
    if (!result.ok && result.reason && result.reason !== 'slow down') {
      sendError(socket, result.reason);
    }
    flushEvents(room);
  });

  socket.on(C2S.leaveRoom, () => {
    const found = sessionRoom(socket);
    if (!found) return;
    const { room, playerId } = found;
    sessions.delete(socket.id);
    void socket.leave(room.code);
    room.removePlayer(playerId, Date.now());
    broadcastLobby(room);
    flushEvents(room);
  });

  socket.on('disconnect', () => {
    const found = sessionRoom(socket);
    sessions.delete(socket.id);
    if (!found) return;
    const { room, playerId } = found;
    room.markDisconnected(playerId, socket.id, Date.now());
    broadcastLobby(room);
    flushEvents(room);
  });
});

// ------------------------------------------------------------- simulation

function flushEvents(room: GameRoom): void {
  const events = room.drainEvents();
  if (events.length > 0) io.to(room.code).emit(S2C.events, { events });
}

let sinceLastSnapshot = 0;

setInterval(() => {
  const now = Date.now();
  sinceLastSnapshot += TICK_INTERVAL_MS;
  const shouldSnapshot = sinceLastSnapshot >= SNAPSHOT_INTERVAL_MS;
  if (shouldSnapshot) sinceLastSnapshot = 0;

  for (const room of rooms.all()) {
    const statusBefore = room.status;
    room.tick(now);
    flushEvents(room);
    if (shouldSnapshot) broadcastSnapshot(room, now);
    if (statusBefore !== room.status) broadcastLobby(room);
  }

  for (const code of rooms.sweep(now)) {
    lastBroadcast.delete(code);
    sinceKeyframe.delete(code);
    log(`room ${code} closed`);
  }
}, TICK_INTERVAL_MS);

// ------------------------------------------------------------------ utils

function readString(payload: unknown, key: string): string {
  const value = readRaw(payload, key);
  return typeof value === 'string' ? value : '';
}

function readRaw(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}

function log(message: string): void {
  console.log(`[nodeRTS] ${message}`);
}

httpServer.listen(PORT, HOST, () => {
  console.log('');
  console.log('  nodeRTS - logistics network RTS');
  console.log('  ------------------------------------------------------');
  console.log(`  listening      http://${HOST}:${PORT}`);
  console.log(`  local          http://localhost:${PORT}`);
  console.log(`  world          ${WORLD_WIDTH} x ${WORLD_HEIGHT}`);
  console.log(`  simulation     ${Math.round(1000 / TICK_INTERVAL_MS)} Hz tick, ${Math.round(1000 / SNAPSHOT_INTERVAL_MS)} Hz snapshots`);
  console.log(`  players        ${MIN_PLAYERS}-${MAX_PLAYERS} per room`);
  console.log(
    `  client build   ${hasClientBuild ? clientDist : 'NOT FOUND (run "npm run build:client", or use "npm run dev" for the Vite dev server on :5173)'}`,
  );
  console.log(
    `  cors           ${ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(', ') : 'same-origin only'}`,
  );
  console.log('  ------------------------------------------------------');
  console.log('');
});
