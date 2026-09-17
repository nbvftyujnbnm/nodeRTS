# nodeRTS

A minimalist online multiplayer real-time strategy game about **logistics networks**.

There are no units. You expand by building supply lines between nodes, and that
supply network *is* your movement, economy, territory, attack and defence at the
same time. You win by capturing enemy headquarters.

- **2 players** — tense and strategic: every line you build is a commitment, and
  a single well-placed cut can hand over half a map.
- **3-6 players** — deliberately chaotic: eliminating someone hands you all of
  their territory, so the game snowballs on purpose.

Supports 2-6 players per room. Server-authoritative. No database, no accounts,
no matchmaking service — rooms live in memory and are addressed by a 4-character
code.

---

## Quick start

```bash
npm install
npm run dev
```

Then open **http://localhost:5173** in **two browser windows**:

1. Window 1: type a name, click **Create Room**, copy the 4-letter room code.
2. Window 2: type a name, paste the code, click **Join Room**.
3. Window 1 (the host): click **Start Game**.

`npm run dev` runs the Vite dev client on port `5173` and the game server on
port `8080`, with websocket traffic proxied from the client to the server.

### All commands

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies. |
| `npm run dev` | Dev mode: Vite client on `:5173` + hot-reloading server on `:8080`. **Open `:5173`.** |
| `npm test` | Run the Vitest suite once (66 tests). |
| `npm run test:watch` | Run the tests in watch mode. |
| `npm run typecheck` | Strict TypeScript check across client, server, shared and tests. |
| `npm run build` | Production build: server to `dist/node/`, client to `dist/client/`. |
| `npm start` | Run the production server. It serves the built client. **Open `:8080`.** |

Production run from scratch:

```bash
npm install
npm run build
npm start
# -> open http://localhost:8080
```

The port comes from the `PORT` environment variable and defaults to `8080`. The
server binds `0.0.0.0`, so it is reachable from other machines on your network:

```bash
PORT=3000 npm start          # production
PORT=3000 npm run dev        # dev (the Vite proxy follows PORT too)
```

`GET /healthz` returns `{ ok, rooms, uptime }` for liveness checks.

### Docker

```bash
docker build -t node-rts .
docker run --rm -p 8080:8080 node-rts
# -> open http://localhost:8080
```

To use a different port: `docker run --rm -e PORT=3000 -p 3000:3000 node-rts`.

---

## Publishing it online

**This game needs a always-on Node process holding open WebSocket
connections.** Rooms live in memory and the server ticks 20 times a second, so
static hosting (GitHub Pages) and request-scoped serverless functions (Vercel
Functions, Netlify Functions, Cloudflare Workers) cannot run the *server*.

There are two ways to ship it.

### Option A — everything on one host (simplest)

Deploy the whole repo to anything that runs a long-lived Node process. The
server serves the built client itself, so there is nothing else to configure
and no CORS to think about.

| Host | How |
| --- | --- |
| **Render** | New > Blueprint, point at this repo. `render.yaml` is included. Free tier sleeps when idle; the first visit after that takes ~30s and any in-progress match is lost. |
| **Fly.io** | `fly launch --no-deploy --copy-config` then `fly deploy --ha=false`. `fly.toml` and the `Dockerfile` are included. |
| **Railway / Koyeb / Cloud Run** | Point them at the `Dockerfile`. Cloud Run needs session affinity on and `--min-instances=1`. |
| **Your own VPS** | `npm ci && npm run build && npm start` behind nginx or Caddy with WebSocket proxying enabled. |

> **Run exactly one instance.** Rooms are in-memory, so a second instance holds
> a completely separate set of them and two friends using the same code could
> land on different servers. Don't enable autoscaling.

### Option B — client on GitHub Pages / Vercel, server elsewhere

You can host the *client* on any static host and point it at a server running
somewhere else. Two settings make this work:

**1. Build the client with the server's URL:**

```bash
VITE_SERVER_URL=https://your-server.example.com npm run build:client
```

For a GitHub Pages *project* site (`https://user.github.io/nodeRTS/`) also set
the sub-path, or every asset 404s:

```bash
VITE_BASE=/nodeRTS/ VITE_SERVER_URL=https://your-server.example.com npm run build:client
```

`.github/workflows/pages.yml` does both automatically. Enable Pages with
"GitHub Actions" as the source and set the repo variable `SERVER_URL`
(Settings > Secrets and variables > Actions > Variables).

For Vercel: framework **Vite**, build command `npm run build:client`, output
directory `dist/client`, and add `VITE_SERVER_URL` as an environment variable.
Leave `VITE_BASE` unset — Vercel serves from the root.

**2. Allow that origin on the server:**

```bash
ALLOWED_ORIGINS=https://user.github.io,https://my-game.vercel.app npm start
```

Comma-separated, no trailing slash, scheme included. The origin is checked on
every transport, not just HTTP polling — a browser will not apply CORS to a
WebSocket upgrade, so an allowlist enforced only through CORS headers would be
bypassed by any page that connects over WebSocket directly.

Notes:
- The origin that the server itself serves the client from is always allowed,
  so Option A keeps working even with a list set.
- Requests with no `Origin` header (curl, scripts, the test suite) are allowed.
  Any such client can spoof the header anyway; the list exists to stop other
  *websites* from opening rooms on your server, not to authenticate anyone.
- `ALLOWED_ORIGINS=*` permits everything. Fine for a throwaway game server.

### Environment variables

| Variable | Where | Default | Meaning |
| --- | --- | --- | --- |
| `PORT` | server | `8080` | Port to bind. The host usually sets this for you. |
| `ALLOWED_ORIGINS` | server | unset | Comma-separated origins allowed to connect. Unset = same-origin only. |
| `VITE_SERVER_URL` | client **build** | unset | Absolute server URL. Unset = same origin. |
| `VITE_BASE` | client **build** | `/` | Sub-path the client is served from. |

The two `VITE_*` values are baked into the bundle at build time, so changing
them means rebuilding the client.

---

## How to play

The world is a fixed 1600x900 board. The canvas scales to your browser window
but world coordinates never change, and there is no camera scrolling.

**Controls**

| Action | Input |
| --- | --- |
| Select one of your nodes | Left click it |
| Build a supply line | With a node selected, left click the destination |
| Cancel the selection | Right click, or `Esc` |

While aiming, the preview line shows the distance, the resource cost and whether
the build is legal. **Green = valid, red = invalid** (the reason is printed in
the panel on the right).

**The rules that matter**

- Only headquarters produce resources (24/second, capped at 500). Everything
  else has to be fed through your network.
- Delivery efficiency drops with route length: a node `d` pixels of *route* away
  costs the HQ `delivered * (1 + 0.0008 * d)`. Sprawling networks are expensive.
- A node only receives supply if it is actually reachable from your HQ through
  **your own** edges. Unsupplied nodes are drawn faded.
- Building costs `18 + 0.11 * distance`, paid immediately out of the source
  node's local stock. Build range is 40-450 pixels. Construction takes
  `0.35 + distance/500` seconds, and you can have 3 running at once (max 1 per
  node).
- Finishing a line normally creates a new base with 0 stock. Finish it within
  ~20px of one of your own nodes and it snaps onto that node instead — this is
  how you deliberately build **loops and redundant routes**.

**Crossing lines is the whole game**

- **Crossing your own line** creates a junction at the intersection and splits
  both lines through it. Arbitrary crossing lines therefore fuse into one
  connected logistics graph, and junctions can store resources and serve as
  build sources.
- **Crossing an enemy line cuts it.** The severed edge is gone. The server then
  recomputes, from the victim's HQ, what they can still reach. **Everything they
  can no longer reach is captured by you instantly**, stocks reset to zero, and
  wired into your network through your new junction.
- **Redundancy is the counterplay.** If the victim has an alternate route to the
  far side, nothing is captured — only the crossed edge is severed. Building
  loops is how you make your territory un-cuttable.
- **Headquarters can be attacked directly.** Aim a construction at an enemy HQ
  (click within its capture radius and the target snaps to its centre). Normal
  range, cost and build time apply. When it completes, that player is
  eliminated.

With 2 players, capturing the enemy HQ wins immediately. With 3+, the
eliminated player's entire empire transfers to the attacker and the match
continues until one player is left.

**Disconnects.** If you close the tab you have ~30 seconds to come back; a
reconnect token is kept in `localStorage` and the client rejoins automatically.
Miss the window during a match and you are eliminated.

---

## Architecture

Single repository, three parts plus shared code.

```
src/
  shared/          types + protocol + ALL tuning constants
    config.ts        <-- every gameplay number lives here
    types.ts         node/edge/construction/snapshot/event types
    protocol.ts      socket.io event names
  game/            pure, authoritative simulation (no sockets, no DOM)
    geometry.ts      segment intersection, distances
    world.ts         node/edge store, server-generated ids
    graph.ts         adjacency, BFS reachability, Dijkstra
    target.ts        what a build click actually aims at
    validate.ts      build validation
    supply.ts        resource production and distribution
    lines.ts         line completion: friendly + hostile intersections, capture
    room.ts          GameRoom: state, tick, constructions, elimination, victory
  server/
    rooms.ts         in-memory room registry + room codes
    index.ts         Express + Socket.IO, tick loop, static file serving
  client/
    main.ts          glue, input handling, lobby/HUD
    net.ts           socket.io wrapper + reconnect token storage
    render.ts        canvas drawing
    index.html / style.css
tests/             Vitest suites
```

### Server authority

The server is the only thing that decides anything. The client sends exactly one
kind of gameplay intent:

```ts
buildLine(fromNodeId, targetX, targetY)
```

Everything else — resource amounts, construction validity, intersection results,
graph connectivity, captures, HQ captures, victory, all ids and all timestamps —
is computed server-side and broadcast. Client input is treated as untrusted:
coordinates are range- and type-checked, node ownership and connectivity are
re-derived from server state, and build requests are rate-limited.

The client *does* import `evaluateBuild` from `src/game/validate.ts`, but purely
to colour its preview line green or red. The server runs the same function as
the authority and will refuse anything illegal regardless of what the client
thinks.

Simulation runs at **20 Hz**; snapshots are broadcast at **10 Hz**. Discrete
events (`constructionStarted`, `supplyLineCut`, `networkCaptured`, `hqCaptured`,
`playerEliminated`, `victory`, ...) are emitted immediately as they happen.
Clients interpolate the construction animation visually and nothing else.

### Tuning

Every gameplay number is in **`src/shared/config.ts`** and is used by both the
server and the client. Change a constant there and it applies everywhere.

---

## Tests

```bash
npm test
```

66 tests across 6 suites. The graph and intersection code is the highest
priority, and the required behaviours map to tests as follows:

| Required behaviour | Suite |
| --- | --- |
| 1. Friendly intersection creates a usable junction | `friendly-intersections.test.ts` |
| 2. Friendly intersection splits both edges correctly | `friendly-intersections.test.ts` |
| 3. Hostile crossing of a bridge disconnects and captures the far side | `hostile-intersections.test.ts` |
| 4. No capture when the victim has an alternate route | `hostile-intersections.test.ts`, `room-integration.test.ts` |
| 5. Captured component changes ownership | `hostile-intersections.test.ts` |
| 6. Captured node stock resets to zero | `hostile-intersections.test.ts` |
| 7. A line crossing multiple edges resolves in deterministic order | `hostile-intersections.test.ts` |
| 8. Shortest-path supply distance | `supply.test.ts` |
| 9. Longer routes consume more HQ resources | `supply.test.ts` |
| 10. Proportional delivery when the HQ cannot pay | `supply.test.ts` |
| 11. Build range and resource validation | `match.test.ts` |
| 12. HQ capture eliminates the victim | `match.test.ts` |
| 13. 2-player HQ capture ends the game | `match.test.ts` |
| 14. 3-player match continues after an elimination | `match.test.ts` |
| 15. Last remaining player wins | `match.test.ts` |
| 16. Reconnection restores control to the correct player | `match.test.ts` |

`geometry.test.ts` covers the segment-intersection primitives directly
(parallel, collinear, shared endpoints, T-touches, would-cross-if-extended), and
`room-integration.test.ts` drives cut-and-capture end to end through the real
`GameRoom` API including emitted events and snapshot shape.

---

## Design decisions

Where the specification left room, the simplest consistent option was taken.
The notable ones:

- **A hostile crossing removes the whole crossed edge.** Rather than keeping two
  victim-side stubs, the severed edge is deleted and the attacker's junction is
  created separately. This makes it structurally impossible for the victim to
  reconnect through the attacker's junction. If a side is then captured, it is
  rewired to that junction as an attacker-owned edge, so captured territory ends
  up supplied.
- **A captured HQ becomes an ordinary base.** The spec says an eliminated
  player's nodes transfer to the attacker, and also that each living player has
  exactly one HQ and only HQs produce. Demoting the captured HQ to a base
  satisfies both and stops anyone from running two production centres.
- **A player eliminated by disconnect timeout has their assets removed**, not
  transferred — there is no attacker to give them to.
- **Isolation is evaluated exactly as specified:** after a cut, any victim-owned
  node not reachable from the victim's HQ is captured.
- **Intersections are proper crossings only.** Two lines that merely touch at a
  shared endpoint already meet in the graph, so there is nothing to split; a
  small epsilon keeps floating point from inventing junctions at endpoints, and
  intersections landing within 1.5px of an existing owned node reuse that node
  instead of stacking a duplicate.
- **Snapshots are full state.** At this scale (tens of nodes) delta encoding
  would be pure overhead.
