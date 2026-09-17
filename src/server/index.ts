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
import type { GameRoom } from '../game/room';
import { RoomManager, normalizeCode } from './rooms';

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const HOST = '0.0.0.0';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  serveClient: false,
  pingInterval: 10_000,
  pingTimeout: 8_000,
});

const rooms = new RoomManager();

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
    socket.emit(S2C.snapshot, room.snapshot(now));
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
    if (shouldSnapshot) io.to(room.code).emit(S2C.snapshot, room.snapshot(now));
    if (statusBefore !== room.status) broadcastLobby(room);
  }

  for (const code of rooms.sweep(now)) {
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
  console.log('  ------------------------------------------------------');
  console.log('');
});
