/**
 * All gameplay tuning constants live here so they are easy to edit in one place.
 * Shared verbatim between the authoritative server simulation and the client
 * (the client uses them only for previews/rendering; the server always decides).
 */

// --- World -------------------------------------------------------------
export const WORLD_WIDTH = 1600;
export const WORLD_HEIGHT = 900;

// --- Simulation cadence ------------------------------------------------
export const TICK_HZ = 20;
export const TICK_INTERVAL_MS = 1000 / TICK_HZ;
export const SNAPSHOT_HZ = 10;
export const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_HZ;

// --- Resources ---------------------------------------------------------
export const HQ_PRODUCTION_PER_SECOND = 24;

/**
 * Extra production per supplied non-HQ node.
 *
 * Without this, territory is worth nothing economically: one node and thirty
 * nodes both produced 24/s, so there was no engine to break a tie and no
 * reason to expand rather than turtle. It also makes the core mechanic pay -
 * cutting an enemy's network does not just take their land, it takes their
 * income, because only nodes still reachable from their HQ count.
 */
export const NODE_PRODUCTION_PER_SECOND = 4;
export const HQ_MAX_STOCK = 500;
export const HQ_INITIAL_STOCK = 220;

export const BASE_MAX_STOCK = 110;
export const JUNCTION_MAX_STOCK = 70;

export const BASE_TRANSFER_RATE = 12; // per second, per receiving node

/** resourceCostAtHQ = delivered * (1 + TRANSPORT_DISTANCE_PENALTY * routeDistance) */
export const TRANSPORT_DISTANCE_PENALTY = 0.0008;

// --- Building ----------------------------------------------------------
export const MAX_BUILD_DISTANCE = 450;
export const MIN_BUILD_DISTANCE = 40;

export const BUILD_BASE_COST = 18;
export const BUILD_DISTANCE_COST = 0.11; // per world pixel

export const BUILD_TIME_BASE = 0.35; // seconds
export const BUILD_TIME_DISTANCE_DIVISOR = 500; // seconds per world pixel

export const MAX_ACTIVE_CONSTRUCTIONS_PER_PLAYER = 3;
export const MAX_ACTIVE_CONSTRUCTIONS_PER_NODE = 1;

/** Completed lines ending this close to one of your own nodes snap onto it. */
export const NODE_SNAP_RADIUS = 20;
/** Clicking this close to an enemy HQ centre targets the HQ itself. */
export const HQ_CAPTURE_RADIUS = 26;

/**
 * Taking a headquarters is the win condition, so it must not be something you
 * can reach with one lucky long line. These three make the killing blow a
 * commitment rather than an opening move:
 *
 * - the assault must be launched from close range, which means dragging a long
 *   thin chain deep into enemy ground where it can be cut,
 * - it costs several times a normal line, so the launching node has to be
 *   fully stocked,
 * - and it takes long enough to land that the defender can still cut the chain
 *   under it, which cancels the construction.
 *
 * Invariant: a full base must be able to afford a maximum-range assault, or
 * headquarters could never be taken at all. Guarded by a test.
 */
export const HQ_ASSAULT_MAX_RANGE = 200;
export const HQ_ASSAULT_COST_MULTIPLIER = 2.5;
export const HQ_ASSAULT_TIME_MULTIPLIER = 5;
/** Intersections closer than this to an existing owned node reuse that node. */
export const JUNCTION_MERGE_EPS = 1.5;
/** Edges shorter than this are never created (avoids degenerate geometry). */
export const MIN_EDGE_LENGTH = 0.5;

// --- Room / lobby ------------------------------------------------------
export const MAX_PLAYERS = 6;
export const MIN_PLAYERS = 2;
export const ROOM_CODE_LENGTH = 4;
export const RECONNECT_GRACE_MS = 30_000;
export const BUILD_REQUEST_MIN_INTERVAL_MS = 120;
export const MAX_NAME_LENGTH = 16;
/** Finished/abandoned rooms are dropped from memory after this long. */
export const ROOM_IDLE_TTL_MS = 10 * 60 * 1000;

// --- Presentation ------------------------------------------------------
export const PLAYER_COLORS = [
  '#ff5a4d',
  '#4aa8ff',
  '#54d64a',
  '#f5c518',
  '#c471f5',
  '#ff9b2f',
] as const;

export function capacityForNodeType(type: 'hq' | 'base' | 'junction'): number {
  switch (type) {
    case 'hq':
      return HQ_MAX_STOCK;
    case 'base':
      return BASE_MAX_STOCK;
    case 'junction':
      return JUNCTION_MAX_STOCK;
  }
}

export function buildCostForDistance(distance: number): number {
  return BUILD_BASE_COST + BUILD_DISTANCE_COST * distance;
}

export function buildTimeForDistance(distance: number): number {
  return BUILD_TIME_BASE + distance / BUILD_TIME_DISTANCE_DIVISOR;
}
