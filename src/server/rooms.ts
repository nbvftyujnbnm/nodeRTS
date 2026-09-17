import { ROOM_CODE_LENGTH, ROOM_IDLE_TTL_MS } from '../shared/config';
import { GameRoom } from '../game/room';

/** Unambiguous alphabet: no O/0, I/1, etc. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RoomManager {
  private readonly rooms = new Map<string, GameRoom>();

  create(now: number): GameRoom {
    const code = this.generateCode();
    const room = new GameRoom({ code });
    room.lastActivityAt = now;
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): GameRoom | undefined {
    return this.rooms.get(normalizeCode(code));
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }

  all(): GameRoom[] {
    return [...this.rooms.values()];
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Drop empty rooms and long-idle finished ones so memory stays bounded. */
  sweep(now: number): string[] {
    const removed: string[] = [];
    for (const [code, room] of this.rooms) {
      const everyoneGone = room.players.size === 0;
      const idle = now - room.lastActivityAt > ROOM_IDLE_TTL_MS;
      const allDisconnected =
        room.players.size > 0 && [...room.players.values()].every((p) => !p.connected);
      if (everyoneGone || (idle && (room.status === 'finished' || allDisconnected))) {
        this.rooms.delete(code);
        removed.push(code);
      }
    }
    return removed;
  }

  private generateCode(): string {
    for (let attempt = 0; attempt < 500; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    // Astronomically unlikely; fall back to a longer code.
    return `${Date.now().toString(36).toUpperCase()}`;
  }
}

export function normalizeCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase().slice(0, 12);
}
