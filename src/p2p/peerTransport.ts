import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import type {
  GameTransport,
  NetHandlers,
  TransportMode,
} from '../client/transport';
import { TICK_INTERVAL_MS } from '../shared/config';
import { generateRoomCode, normalizeRoomCode } from '../shared/roomCode';
import { HostSession, type HostClient } from './host';
import { peerIdForCode, type GuestToHost, type HostToGuest } from './protocol';

/** Silence from the host for this long means the match is over. */
const HOST_SILENCE_TIMEOUT_MS = 4_000;

/**
 * Peer-to-peer transport.
 *
 * The player who creates the room runs the authoritative simulation in their
 * own browser; everyone else is a guest over a WebRTC data channel. Nothing is
 * hosted, which is what makes a purely static deployment playable.
 *
 * Trade-off worth knowing: the host's browser *is* the authority, so a
 * determined host could tamper with the game. Guests cannot - every message
 * they send is validated by the same GameRoom the real server uses.
 */
export class PeerTransport implements GameTransport {
  readonly mode: TransportMode = 'p2p';

  private peer: Peer | null = null;
  private session: HostSession | null = null;
  private connection: DataConnection | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private pendingName = '';
  private hostAttempts = 0;
  private disposed = false;

  /** Guest-side details kept so a dropped data channel can be retried once. */
  private guestCode = '';
  private guestToken = '';
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retriedAfterDrop = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly handlers: NetHandlers) {}

  // ------------------------------------------------------------- hosting

  createRoom(name: string): void {
    this.pendingName = name;
    this.hostAttempts = 0;
    this.openAsHost();
  }

  private openAsHost(): void {
    if (this.disposed) return;
    const code = generateRoomCode();
    const peer = new Peer(peerIdForCode(code), peerOptions());
    this.peer = peer;

    peer.on('open', () => {
      if (this.disposed) return;
      const session = new HostSession(code);
      this.session = session;

      // The host player is a client too, so there is one code path for all.
      const localClient: HostClient = {
        id: 'local',
        send: (message) => this.dispatch(message),
        close: () => {},
      };
      session.addClient(localClient);
      session.receive('local', { t: 'hello', name: this.pendingName }, Date.now());

      this.ticker = setInterval(() => {
        session.tick(Date.now(), TICK_INTERVAL_MS);
      }, TICK_INTERVAL_MS);

      this.handlers.onConnectionChange(true);
    });

    peer.on('connection', (connection) => this.acceptGuest(connection));

    peer.on('error', (error) => {
      const type = (error as { type?: string }).type;
      // Someone else already holds that room code on the broker; try another.
      if (type === 'unavailable-id' && this.hostAttempts < 5 && !this.session) {
        this.hostAttempts++;
        peer.destroy();
        this.openAsHost();
        return;
      }
      this.handlers.onError(describePeerError(error));
    });
  }

  private acceptGuest(connection: DataConnection): void {
    const clientId = connection.connectionId;
    connection.on('open', () => {
      this.session?.addClient({
        id: clientId,
        send: (message) => {
          if (connection.open) connection.send(message);
        },
        close: () => connection.close(),
      });
    });
    connection.on('data', (data) => {
      this.session?.receive(clientId, data, Date.now());
    });
    connection.on('close', () => this.session?.dropClient(clientId, Date.now()));
    connection.on('error', () => this.session?.dropClient(clientId, Date.now()));
  }

  // -------------------------------------------------------------- joining

  joinRoom(code: string, name: string): void {
    this.connectToHost(normalizeRoomCode(code), { t: 'hello', name });
  }

  tryReconnect(roomCode: string, token: string): void {
    this.connectToHost(normalizeRoomCode(roomCode), { t: 'resume', token });
  }

  private connectToHost(code: string, greeting: GuestToHost): void {
    if (this.disposed) return;
    if (code.length === 0) {
      this.handlers.onError('enter a room code');
      return;
    }
    this.guestCode = code;
    this.peer?.destroy();
    const peer = new Peer(peerOptions());
    this.peer = peer;

    peer.on('open', () => {
      if (this.disposed) return;
      const connection = peer.connect(peerIdForCode(code), { reliable: true });
      this.connection = connection;

      connection.on('open', () => {
        this.handlers.onConnectionChange(true);
        connection.send(greeting);
        this.armWatchdog();
      });
      connection.on('data', (data) => this.dispatch(data));
      connection.on('close', () => this.handleHostLost());
      connection.on('error', (error) => this.handlers.onError(describePeerError(error)));
    });

    peer.on('error', (error) => {
      const type = (error as { type?: string }).type;
      if (type === 'peer-unavailable') {
        // Resuming into a room that no longer exists is terminal: in P2P the
        // game state lived in the host's tab and went with it.
        if (greeting.t === 'resume') {
          this.handlers.onKicked('the host is no longer hosting this room', true);
        } else {
          this.handlers.onError(`no room with code ${code}`);
        }
        return;
      }
      this.handlers.onError(describePeerError(error));
    });
  }

  // --------------------------------------------------------------- intents

  startGame(): void {
    this.send({ t: 'start' });
  }

  buildLine(fromNodeId: string, targetX: number, targetY: number): void {
    this.send({ t: 'build', fromNodeId, targetX, targetY });
  }

  leaveRoom(): void {
    this.send({ t: 'bye' });
    this.dispose();
  }

  private send(message: GuestToHost): void {
    if (this.session) {
      this.session.receive('local', message, Date.now());
    } else if (this.connection?.open) {
      this.connection.send(message);
    }
  }

  /**
   * Detect a vanished host from the absence of traffic rather than from ICE.
   *
   * The host broadcasts a snapshot ten times a second in every room state, so
   * silence means they are gone. Waiting for WebRTC to notice is not good
   * enough: when a tab closes abruptly the remote side only learns about it
   * through ICE consent expiry, which takes tens of seconds, and the guest sits
   * in front of a board that will never update again.
   */
  private armWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.handleHostLost(), HOST_SILENCE_TIMEOUT_MS);
  }

  /**
   * The data channel to the host dropped.
   *
   * The host may just have had a blip, so retry once - their reconnect window
   * is still open and our token is still good. If the room is really gone the
   * retry reports peer-unavailable and we bail out to the menu.
   */
  private handleHostLost(): void {
    if (this.disposed || this.session) return;
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.handlers.onConnectionChange(false);

    if (this.guestToken && !this.retriedAfterDrop) {
      this.retriedAfterDrop = true;
      this.handlers.onError('lost the host - trying to reconnect...');
      this.retryTimer = setTimeout(() => {
        this.connectToHost(this.guestCode, { t: 'resume', token: this.guestToken });
      }, 1500);
      return;
    }
    this.handlers.onKicked('the host left, so the match ended', true);
  }

  /** Host -> guest messages, routed into the same handlers the socket uses. */
  private dispatch(raw: unknown): void {
    const message = raw as HostToGuest;
    if (typeof message !== 'object' || message === null) return;
    if (!this.session) this.armWatchdog(); // any traffic proves the host is alive
    switch (message.t) {
      case 'joined':
        this.guestToken = message.reconnectToken;
        this.retriedAfterDrop = false;
        this.handlers.onRoomJoined({
          roomCode: message.roomCode,
          playerId: message.playerId,
          reconnectToken: message.reconnectToken,
          status: message.status,
        });
        break;
      case 'lobby':
        this.handlers.onLobby({
          roomCode: message.roomCode,
          hostId: message.hostId,
          status: message.status,
          players: message.players,
        });
        break;
      case 'snap':
        this.handlers.onSnapshot(message.snapshot);
        break;
      case 'events':
        this.handlers.onEvents(message.events ?? []);
        break;
      case 'err':
        this.handlers.onError(message.message);
        break;
      case 'kick':
        this.handlers.onKicked(message.message, true);
        break;
      default:
        break;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.session?.dispose();
    this.session = null;
    this.connection?.close();
    this.connection = null;
    this.peer?.destroy();
    this.peer = null;
  }
}

/**
 * Broker and ICE configuration.
 *
 * With nothing set this uses the free public PeerJS broker for signalling and
 * public STUN, which needs no account. Set VITE_PEER_* to point at your own
 * broker, and VITE_ICE_SERVERS (a JSON array) to add a TURN server for players
 * behind symmetric NAT, where a direct peer connection cannot be established.
 */
function peerOptions(): PeerOptions {
  const options: PeerOptions = {};
  const host = import.meta.env.VITE_PEER_HOST;
  if (host) {
    options.host = host;
    if (import.meta.env.VITE_PEER_PORT) {
      options.port = Number.parseInt(import.meta.env.VITE_PEER_PORT, 10);
    }
    options.path = import.meta.env.VITE_PEER_PATH || '/';
    options.secure = import.meta.env.VITE_PEER_SECURE === '1';
  }

  const ice = import.meta.env.VITE_ICE_SERVERS;
  if (ice) {
    try {
      options.config = { iceServers: JSON.parse(ice) as RTCIceServer[] };
    } catch {
      console.warn('[nodeRTS] VITE_ICE_SERVERS is not valid JSON; using defaults');
    }
  }
  return options;
}

function describePeerError(error: unknown): string {
  const type = (error as { type?: string }).type;
  switch (type) {
    case 'peer-unavailable':
      return 'that room is not open';
    case 'unavailable-id':
      return 'could not claim a room code, try again';
    case 'browser-incompatible':
      return 'this browser does not support WebRTC';
    case 'network':
    case 'server-error':
      return 'could not reach the matchmaking broker';
    case 'webrtc':
      return 'the direct connection failed (a strict NAT may need a TURN server)';
    default:
      return (error as { message?: string }).message ?? 'connection error';
  }
}
