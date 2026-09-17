import {
  HQ_ASSAULT_COST_MULTIPLIER,
  HQ_ASSAULT_MAX_RANGE,
  MAX_BUILD_DISTANCE,
  MIN_PLAYERS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '../shared/config';
import { evaluateBuild, type BuildContext } from '../game/validate';
import type { GameEvent, NodeSnapshot, PlayerPublic, Snapshot } from '../shared/types';
import { Net, loadStoredSession, storeSession } from './net';
import { PeerTransport } from '../p2p/peerTransport';
import type {
  GameTransport,
  LobbyPayload,
  NetHandlers,
  RoomJoinedPayload,
  TransportMode,
} from './transport';
import { nodeRadius, render, type PreviewLine, type RenderState } from './render';
import {
  clampCamera,
  createCamera,
  isFitted,
  startingCamera,
  zoomAt,
  type Camera,
  type Point,
  type Viewport,
} from './camera';
import { attachGestures } from './gestures';

// ------------------------------------------------------------------ DOM

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

const canvas = $<HTMLCanvasElement>('board');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('canvas 2d context unavailable');

const overlay = $('overlay');
const viewMenu = $('view-menu');
const viewLobby = $('view-lobby');
const viewResult = $('view-result');
const hud = $('hud');
const logBox = $('log');
const overlayError = $('overlay-error');

const inputName = $<HTMLInputElement>('input-name');
const modePicker = $('mode-picker');
const modeHint = $('mode-hint');
const inputCode = $<HTMLInputElement>('input-code');
const btnCreate = $<HTMLButtonElement>('btn-create');
const btnJoin = $<HTMLButtonElement>('btn-join');
const btnStart = $<HTMLButtonElement>('btn-start');
const btnCopy = $<HTMLButtonElement>('btn-copy');
const btnLeave = $<HTMLButtonElement>('btn-leave');
const btnAgain = $<HTMLButtonElement>('btn-again');
const lobbyCode = $('lobby-code');
const lobbyPlayers = $('lobby-players');
const lobbyHint = $('lobby-hint');
const resultTitle = $('result-title');
const resultDetail = $('result-detail');
const hudRoomCode = $('hud-room-code');
const hudPlayers = $('hud-players');
const hudSelection = $('hud-selection');
const hudBuild = $('hud-build');
const viewControls = $('view-controls');
const btnZoomIn = $<HTMLButtonElement>('btn-zoom-in');
const btnZoomOut = $<HTMLButtonElement>('btn-zoom-out');
const btnZoomFit = $<HTMLButtonElement>('btn-zoom-fit');
const btnCancelSel = $<HTMLButtonElement>('btn-cancel-sel');
const controlsHq = $('controls-hq');

// Written from the constants so the on-screen rules cannot drift from the sim.
controlsHq.textContent =
  `Storm an enemy HQ from within ${HQ_ASSAULT_MAX_RANGE}px ` +
  `(costs ${HQ_ASSAULT_COST_MULTIPLIER}x) to eliminate them`;

// ---------------------------------------------------------------- state

interface ClientState {
  youId: string | null;
  roomCode: string | null;
  hostId: string | null;
  lobbyPlayers: PlayerPublic[];
  snapshot: Snapshot | null;
  snapshotReceivedAt: number;
  selectedNodeId: string | null;
  hoverNodeId: string | null;
  mouseWorld: { x: number; y: number } | null;
  status: 'menu' | 'lobby' | 'playing' | 'finished';
  camera: Camera;
  view: Viewport;
  dpr: number;
}

const state: ClientState = {
  youId: null,
  roomCode: null,
  hostId: null,
  lobbyPlayers: [],
  snapshot: null,
  snapshotReceivedAt: 0,
  selectedNodeId: null,
  hoverNodeId: null,
  mouseWorld: null,
  status: 'menu',
  camera: { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2, scale: 1 },
  view: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
  dpr: 1,
};

const savedName = (() => {
  try {
    return localStorage.getItem('nodeRTS.name') ?? '';
  } catch {
    return '';
  }
})();
inputName.value = savedName;

// ------------------------------------------------------------- networking

/**
 * socket.io hands out a fresh socket id on every transport reconnect, so the
 * server has no session for the new socket until we re-present our token. This
 * must happen on *every* connect, not just the first one after a page load.
 */
let reconnectPending = false;

/** Transport chosen in the menu; the session is created lazily on join. */
const P2P_ONLY = import.meta.env.VITE_P2P_ONLY === '1';
let selectedMode: TransportMode =
  P2P_ONLY || import.meta.env.VITE_DEFAULT_MODE === 'p2p' ? 'p2p' : 'server';
let net: GameTransport | null = null;

const handlers: NetHandlers = {
  onConnectionChange(connected) {
    if (connected) {
      // Only the socket transport silently re-dials; a P2P session already
      // presented its token when the data channel opened.
      const stored = loadStoredSession();
      if (stored && net?.mode === 'server' && stored.mode === 'server') {
        reconnectPending = true;
        net.tryReconnect(stored.roomCode, stored.token);
      }
    } else {
      pushLog('connection lost - trying to reconnect...', 'attack');
    }
  },
  onRoomJoined(payload: RoomJoinedPayload) {
    reconnectPending = false;
    state.youId = payload.playerId;
    state.roomCode = payload.roomCode;
    storeSession({
      roomCode: payload.roomCode,
      token: payload.reconnectToken,
      mode: net?.mode ?? selectedMode,
    });
    overlayError.textContent = '';
    lobbyCode.textContent = payload.roomCode;
    hudRoomCode.textContent = payload.roomCode;
  },
  onLobby(payload: LobbyPayload) {
    state.hostId = payload.hostId;
    state.lobbyPlayers = payload.players;
    state.roomCode = payload.roomCode;
    lobbyCode.textContent = payload.roomCode;
    hudRoomCode.textContent = payload.roomCode;
    if (payload.status === 'lobby') setStatus('lobby');
    else if (payload.status === 'playing') setStatus('playing');
    renderLobby();
  },
  onSnapshot(snapshot) {
    state.snapshot = snapshot;
    state.snapshotReceivedAt = performance.now();
    state.hostId = snapshot.hostId;
    state.lobbyPlayers = snapshot.players;
    if (snapshot.status === 'playing') setStatus('playing');
    else if (snapshot.status === 'finished') showResult(snapshot);
    if (state.selectedNodeId && !snapshot.nodes.some((n) => n.id === state.selectedNodeId)) {
      setSelection(null);
    }
    if (needsHomeFocus && snapshot.status === 'playing') focusHome();
    renderHud();
  },
  onEvents(events) {
    for (const event of events) handleEvent(event);
  },
  onError(message) {
    overlayError.textContent = message;
    pushLog(message, 'attack');
    window.setTimeout(() => {
      if (overlayError.textContent === message) overlayError.textContent = '';
    }, 4000);
  },
  onKicked(message, fatal) {
    // A non-fatal kick is only meaningful as the answer to our own reconnect
    // attempt; a late failure for an old session must not evict us from a room
    // we just joined. A fatal one always applies.
    if (!fatal && !reconnectPending) return;
    reconnectPending = false;
    storeSession(null);
    net?.dispose();
    net = null;
    state.youId = null;
    setStatus('menu');
    overlayError.textContent = message;
  },
};

function makeTransport(mode: TransportMode): GameTransport {
  net?.dispose();
  net = mode === 'p2p' ? new PeerTransport(handlers) : new Net(handlers);
  return net;
}

function setMode(mode: TransportMode): void {
  selectedMode = mode;
  for (const button of modePicker.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.mode === mode);
  }
  modeHint.textContent =
    mode === 'p2p'
      ? 'Peer-to-peer: no server needed. The player who creates the room hosts the match, so they must stay connected.'
      : 'Server: the game server runs the match. Everyone can come and go.';
}

// ------------------------------------------------------------------ views

function setStatus(next: ClientState['status']): void {
  if (state.status === next) return;
  state.status = next;
  overlay.classList.toggle('hidden', next === 'playing');
  hud.classList.toggle('hidden', next !== 'playing');
  viewControls.classList.toggle('hidden', next !== 'playing');
  viewMenu.classList.toggle('hidden', next !== 'menu');
  viewLobby.classList.toggle('hidden', next !== 'lobby');
  viewResult.classList.toggle('hidden', next !== 'finished');
  if (next === 'menu') {
    state.snapshot = null;
    setSelection(null);
    state.roomCode = null;
  }
  if (next === 'playing') {
    needsHomeFocus = true;
    focusHome();
  }
}

function renderLobby(): void {
  lobbyPlayers.innerHTML = '';
  for (const player of state.lobbyPlayers) {
    const li = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = player.color;
    const name = document.createElement('span');
    name.textContent = player.name + (player.id === state.youId ? ' (you)' : '');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = [player.id === state.hostId ? 'HOST' : '', player.connected ? '' : 'OFFLINE']
      .filter(Boolean)
      .join(' ');
    li.append(swatch, name, tag);
    lobbyPlayers.append(li);
  }

  const isHost = state.youId !== null && state.youId === state.hostId;
  const enough = state.lobbyPlayers.length >= MIN_PLAYERS;
  btnStart.classList.toggle('hidden', !isHost);
  btnStart.disabled = !enough;
  lobbyHint.textContent = isHost
    ? enough
      ? 'Everyone in? Start the match.'
      : `Waiting for players (${state.lobbyPlayers.length}/${MIN_PLAYERS} minimum)`
    : 'Waiting for the host to start...';
}

function showResult(snapshot: Snapshot): void {
  const winner = snapshot.players.find((p) => p.id === snapshot.winnerId);
  resultTitle.textContent = winner
    ? winner.id === state.youId
      ? 'You win'
      : `${winner.name} wins`
    : 'Nobody wins';
  resultDetail.textContent = winner
    ? `${winner.name} held the last headquarters standing.`
    : 'Every headquarters fell.';
  setStatus('finished');
}

function renderHud(): void {
  const snapshot = state.snapshot;
  if (!snapshot) return;

  hudPlayers.innerHTML = '';
  for (const player of snapshot.players) {
    const li = document.createElement('li');
    li.className = [player.alive ? '' : 'dead', player.connected ? '' : 'offline']
      .filter(Boolean)
      .join(' ');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = player.color;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = player.name;
    li.append(swatch, name);
    if (player.id === state.youId) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = '(you)';
      li.append(you);
    }
    hudPlayers.append(li);
  }

  const selected = snapshot.nodes.find((n) => n.id === state.selectedNodeId);
  hudSelection.textContent = selected
    ? `${selected.type.toUpperCase()} - stock ${Math.floor(selected.stock)}/${selected.capacity}${
        selected.connected ? '' : ' - UNSUPPLIED'
      }`
    : 'No node selected';
}

// ------------------------------------------------------------ event ticker

function nameOf(playerId: string): string {
  return state.lobbyPlayers.find((p) => p.id === playerId)?.name ?? playerId;
}

function handleEvent(event: GameEvent): void {
  switch (event.type) {
    case 'playerJoined':
      pushLog(`${event.name} joined`);
      break;
    case 'playerLeft':
      pushLog(`${event.name} left`);
      break;
    case 'playerDisconnected':
      pushLog(`${event.name} disconnected (30s to return)`, 'attack');
      break;
    case 'playerReconnected':
      pushLog(`${event.name} reconnected`, 'good');
      break;
    case 'matchStarted':
      pushLog('match started - expand your network', 'good');
      break;
    case 'supplyLineCut':
      pushLog(`${nameOf(event.attackerId)} cut a supply line of ${nameOf(event.victimId)}`, 'attack');
      break;
    case 'networkCaptured':
      pushLog(
        `${nameOf(event.attackerId)} captured ${event.nodeIds.length} node(s) from ${nameOf(event.victimId)}`,
        event.attackerId === state.youId ? 'good' : 'attack',
      );
      break;
    case 'hqCaptured':
      pushLog(`${nameOf(event.attackerId)} captured the HQ of ${nameOf(event.victimId)}!`, 'attack');
      break;
    case 'playerEliminated':
      pushLog(
        `${nameOf(event.playerId)} eliminated${event.reason === 'disconnect' ? ' (disconnected)' : ''}`,
        'attack',
      );
      break;
    case 'victory':
      pushLog(event.winnerId ? `${nameOf(event.winnerId)} wins!` : 'nobody wins', 'good');
      break;
    default:
      break;
  }
}

function pushLog(message: string, kind: '' | 'good' | 'attack' = ''): void {
  const div = document.createElement('div');
  if (kind) div.className = kind;
  div.textContent = message;
  logBox.prepend(div);
  while (logBox.childElementCount > 8) logBox.lastElementChild?.remove();
}

// ------------------------------------------------------------------ input

/**
 * Size the backing store to the element's real size so the board is crisp on
 * high-density screens, and keep the camera legal for the new viewport.
 */
function resizeCanvas(): void {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  // Cap the ratio: a 3x backing store on a large phone costs more than it shows.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  state.view = { width, height };
  state.dpr = dpr;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  setCamera(state.camera);
}

function setCamera(camera: Camera): void {
  state.camera = clampCamera(camera, state.view);
  btnZoomOut.disabled = isFitted(state.camera, state.view);
}

function fitBoard(): void {
  setCamera(createCamera(state.view));
}

/** One-shot: frame the player's own HQ when their first real snapshot lands. */
let needsHomeFocus = true;

function focusHome(): void {
  const home = state.snapshot?.nodes.find(
    (n) => n.type === 'hq' && n.ownerId === state.youId,
  );
  setCamera(startingCamera(state.view, home ?? null));
  if (home) needsHomeFocus = false;
}

window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => window.setTimeout(resizeCanvas, 150));

/**
 * Nearest node under a point, using the same radius the renderer drew plus a
 * finger-sized margin so small nodes stay tappable.
 */
function nodeAt(point: Point): NodeSnapshot | null {
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  const worldPerPixel = 1 / state.camera.scale;
  const slop = 10 * worldPerPixel;

  let best: NodeSnapshot | null = null;
  let bestDist = Infinity;
  for (const node of snapshot.nodes) {
    const reach = nodeRadius(node.type, worldPerPixel) + slop;
    const d = Math.hypot(node.x - point.x, node.y - point.y);
    if (d <= reach && d < bestDist) {
      best = node;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Preview-only evaluation. The server re-runs exactly this validation and is
 * the only thing that can actually create a line.
 */
function contextFromSnapshot(snapshot: Snapshot, youId: string): BuildContext {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const me = snapshot.players.find((p) => p.id === youId);
  return {
    playerId: youId,
    alive: me?.alive ?? false,
    nodes: snapshot.nodes,
    getNode: (id) => byId.get(id),
    isConnectedToHq: (id) => byId.get(id)?.connected ?? false,
    activeConstructionsForPlayer: snapshot.constructions.filter((c) => c.ownerId === youId).length,
    activeConstructionsOnNode: (id) =>
      snapshot.constructions.filter((c) => c.sourceNodeId === id).length,
    alivePlayerIds: new Set(snapshot.players.filter((p) => p.alive).map((p) => p.id)),
  };
}

function currentPreview(): PreviewLine | null {
  const snapshot = state.snapshot;
  const youId = state.youId;
  const aim = state.mouseWorld;
  if (!snapshot || !youId || !aim || !state.selectedNodeId) return null;
  const source = snapshot.nodes.find((n) => n.id === state.selectedNodeId);
  if (!source) return null;

  const evaluation = evaluateBuild(
    contextFromSnapshot(snapshot, youId),
    state.selectedNodeId,
    aim.x,
    aim.y,
  );
  const target = evaluation.target ?? { x: aim.x, y: aim.y, kind: 'new' as const, node: null };
  const label = evaluation.ok
    ? `${Math.round(evaluation.distance)}px  cost ${Math.round(evaluation.cost)}${
        target.kind === 'enemyHq' ? '  ATTACK HQ' : target.kind === 'snap' ? '  link' : ''
      }`
    : evaluation.reason ?? 'invalid';

  return {
    fromX: source.x,
    fromY: source.y,
    toX: target.x,
    toY: target.y,
    valid: evaluation.ok,
    label,
  };
}

function setSelection(nodeId: string | null): void {
  state.selectedNodeId = nodeId;
  btnCancelSel.classList.toggle('hidden', nodeId === null);
  renderHud();
}

function playable(): boolean {
  return state.snapshot?.status === 'playing' && state.youId !== null;
}

/** A tap with nothing selected picks one of your own nodes. */
function handleTap(world: Point): void {
  if (!playable()) return;
  const clicked = nodeAt(world);
  if (clicked && clicked.ownerId === state.youId) setSelection(clicked.id);
}

/** Releasing an aim commits the build the preview was showing. */
function handleAimRelease(world: Point): void {
  const snapshot = state.snapshot;
  const youId = state.youId;
  if (!playable() || !snapshot || !youId || !state.selectedNodeId) return;

  const evaluation = evaluateBuild(
    contextFromSnapshot(snapshot, youId),
    state.selectedNodeId,
    world.x,
    world.y,
  );
  const clicked = nodeAt(world);

  // Forgiving reselect: an impossible build onto one of your own nodes just
  // moves the selection there instead of nagging.
  if (!evaluation.ok && clicked && clicked.ownerId === youId) {
    setSelection(clicked.id);
    return;
  }

  net?.buildLine(state.selectedNodeId, world.x, world.y);
  setSelection(null);
  state.mouseWorld = null;
}

attachGestures(canvas, {
  getCamera: () => state.camera,
  setCamera,
  getView: () => state.view,
  isAiming: () => state.selectedNodeId !== null && playable(),
  onTap: handleTap,
  onAimMove: (world) => {
    state.mouseWorld = world;
  },
  onAimRelease: handleAimRelease,
  onCancel: () => setSelection(null),
  onHover: (world) => {
    state.mouseWorld = world;
    state.hoverNodeId = world ? nodeAt(world)?.id ?? null : null;
  },
});

btnZoomIn.addEventListener('click', () => zoomFromCentre(1.4));
btnZoomOut.addEventListener('click', () => zoomFromCentre(1 / 1.4));
btnZoomFit.addEventListener('click', fitBoard);
btnCancelSel.addEventListener('click', () => setSelection(null));

function zoomFromCentre(factor: number): void {
  setCamera(
    zoomAt(state.camera, state.view, { x: state.view.width / 2, y: state.view.height / 2 }, factor),
  );
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setSelection(null);
  if (event.key === '0') fitBoard();
});

// ----------------------------------------------------------- menu actions

function currentName(): string {
  const name = inputName.value.trim();
  try {
    localStorage.setItem('nodeRTS.name', name);
  } catch {
    /* ignore */
  }
  return name;
}

btnCreate.addEventListener('click', () => makeTransport(selectedMode).createRoom(currentName()));
btnJoin.addEventListener('click', () => {
  const code = inputCode.value.trim().toUpperCase();
  if (!code) {
    overlayError.textContent = 'enter a room code';
    return;
  }
  makeTransport(selectedMode).joinRoom(code, currentName());
});

for (const button of modePicker.querySelectorAll('button')) {
  button.addEventListener('click', () => setMode(button.dataset.mode === 'p2p' ? 'p2p' : 'server'));
}
inputCode.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') btnJoin.click();
});
btnStart.addEventListener('click', () => net?.startGame());
btnCopy.addEventListener('click', async () => {
  const code = state.roomCode ?? '';
  try {
    await navigator.clipboard.writeText(code);
    btnCopy.textContent = 'Copied';
  } catch {
    btnCopy.textContent = code;
  }
  window.setTimeout(() => {
    btnCopy.textContent = 'Copy';
  }, 1500);
});
function returnToMenu(): void {
  net?.leaveRoom();
  net = null;
  storeSession(null);
  reconnectPending = false;
  state.youId = null;
  setStatus('menu');
}

btnLeave.addEventListener('click', returnToMenu);
btnAgain.addEventListener('click', returnToMenu);

// ------------------------------------------------------------- draw loop

let lastBuildLabel = '';

function frame(): void {
  const preview = currentPreview();

  const renderState: RenderState = {
    camera: state.camera,
    view: state.view,
    dpr: state.dpr,
    snapshot: state.snapshot,
    snapshotReceivedAt: state.snapshotReceivedAt,
    youId: state.youId,
    selectedNodeId: state.selectedNodeId,
    hoverNodeId: state.hoverNodeId,
    preview,
  };
  render(ctx as CanvasRenderingContext2D, renderState);

  const label = preview ? preview.label : '';
  if (label !== lastBuildLabel) {
    lastBuildLabel = label;
    hudBuild.textContent = label
      ? `${preview?.valid ? 'BUILD' : 'BLOCKED'}: ${label}`
      : `Select one of your nodes (max range ${MAX_BUILD_DISTANCE}px)`;
    hudBuild.className = preview ? (preview.valid ? 'valid' : 'invalid') : '';
  }

  requestAnimationFrame(frame);
}

resizeCanvas();
fitBoard();
requestAnimationFrame(frame);
setStatus('menu');

if (P2P_ONLY) modePicker.classList.add('hidden');
setMode(selectedMode);

// Resume an interrupted match if we have a token for one.
const restored = loadStoredSession();
if (restored) {
  setMode(restored.mode);
  reconnectPending = true;
  makeTransport(restored.mode).tryReconnect(restored.roomCode, restored.token);
}
