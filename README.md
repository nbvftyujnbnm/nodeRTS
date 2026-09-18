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

## Two ways to play

The menu offers two transports, and the game itself is identical in both.

| | **Peer-to-peer** | **Server** |
| --- | --- | --- |
| Who runs the match | The player who created the room, in their browser | A Node server |
| Hosting cost | None. A static page is enough | Needs an always-on process |
| Host leaves | Match ends for everyone | Match continues |
| Cheating | The host *could* tamper with their own authority | Nobody can |
| Needs | WebRTC (any modern browser) | A reachable server |

In both cases a single authority owns the state and validates every message
through the same `GameRoom`. Guests in a P2P match are exactly as constrained
as clients talking to the real server — it is only the *host* who, being the
authority, is trusted. For a game among friends that is usually fine; for
strangers, run the server.

---

## Publishing it online

### Free, no server at all — GitHub Pages + peer-to-peer

This is the cheapest way to get a public URL, and it is what the included
workflow does by default:

1. Push this repo to GitHub.
2. Settings > Pages > Source: **GitHub Actions**.
3. Push to `main`. `.github/workflows/pages.yml` builds a P2P client and
   publishes it.

That is the whole setup. `https://<user>.github.io/<repo>/` is now playable:
one player clicks **Create Room** and hosts the match in their own browser,
everyone else joins with the code over WebRTC.

The same build works on Vercel, Netlify, Cloudflare Pages or any static host —
framework **Vite**, build command `npm run build:client`, output `dist/client`,
and set `VITE_DEFAULT_MODE=p2p` (plus `VITE_P2P_ONLY=1` to hide the unusable
server option). Leave `VITE_BASE` unset outside GitHub Pages project sites.

**What you should know before choosing this:**

- **The host must stay.** Their browser *is* the game. If they close the tab
  the match ends; guests get told and return to the menu after ~4 seconds.
  There is no host migration.
- **Keep the host's tab in the foreground.** Browsers throttle timers in
  background tabs, which slows the simulation for everyone.
- **Signalling uses the free public PeerJS broker.** No account, but it is a
  shared best-effort service. Point `VITE_PEER_HOST` at your own broker
  (`npx peerjs --port 9000`) if you would rather not depend on it. Only the
  initial handshake goes through it; gameplay is direct between browsers.
- **A few networks block direct connections.** Most home and mobile networks
  are fine, but symmetric NAT (some corporate and carrier networks) needs a
  TURN relay. Set `VITE_ICE_SERVERS` to a JSON array of `RTCIceServer` entries
  if a player cannot connect. Free TURN is hard to come by; this is the one
  case where the server option is genuinely easier.

### With a server

**A Node process must stay running** — rooms live in memory and the server
ticks 20 times a second, so static hosting and request-scoped serverless
functions (Vercel Functions, Netlify Functions, Cloudflare Workers) cannot run
the *server* side.

#### Option A — everything on one host (simplest)

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

#### Option B — client on a static host, server elsewhere

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

`.github/workflows/pages.yml` does both automatically. Set the repo variable
`SERVER_URL` (Settings > Secrets and variables > Actions > Variables) and the
menu gains a **Server** option next to peer-to-peer.

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
| `VITE_DEFAULT_MODE` | client **build** | `server` | Which transport the menu starts on: `server` or `p2p`. |
| `VITE_P2P_ONLY` | client **build** | unset | `1` hides the server option entirely. |
| `VITE_PEER_HOST` / `_PORT` / `_PATH` / `_SECURE` | client **build** | unset | Your own PeerJS broker. Unset uses the free public one. |
| `VITE_ICE_SERVERS` | client **build** | unset | JSON array of `RTCIceServer` entries, for adding TURN. |

The two `VITE_*` values are baked into the bundle at build time, so changing
them means rebuilding the client.

---

## How to play

The world is a fixed 1600x900 board. The canvas scales to your browser window
but world coordinates never change, and there is no camera scrolling.

**Controls** - the same on a desktop, a tablet and a phone.

| Action | Mouse | Touch |
| --- | --- | --- |
| Select one of your nodes | Left click it | Tap it |
| Build a supply line | Click the destination, or drag from the node and release | Tap the destination, or drag to aim and release |
| Pan | Drag empty space, or right-drag | Drag empty space, or two fingers |
| Zoom | Wheel / trackpad | Pinch |
| Fit the whole board | The fit button, or `0` | The fit button |
| Cancel the selection | Right click, or `Esc` | The **Cancel selection** button |
| Hide the log and help | `H`, or the ⓘ button | The ⓘ button |

Hiding the log and the control notes is remembered between sessions.

Dragging from a selected node shows the live preview - distance, cost and
whether it is legal - before you commit, which is the only way to get that
feedback on a touch screen where there is no hover.

The board is a fixed 1600x900 world; the canvas fills whatever viewport it is
given and the camera decides what you see. You cannot zoom out past the whole
board or drag it off screen. A match opens fully fitted on anything at least as
wide as 16:9, and opens closer in, framed on your own HQ, on a portrait phone
where a fitted board would be too small to read.

While aiming, the preview line shows the distance, the resource cost and whether
the build is legal. **Green = valid, red = invalid** (the reason is printed in
the panel on the right).

**The rules that matter**

- Headquarters produce resources, and **supplied territory adds to it**: 24/s
  at the HQ plus 4/s for every one of your **bases** still reachable from it,
  capped at 500. Expanding pays for itself, and a network that has been cut
  apart stops producing for the half that is severed.
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

- **Crossing your own line** joins the two lines together, so arbitrary
  crossing lines fuse into one connected logistics graph. On screen it is just
  two lines crossing: the graph keeps a junction node there, but it is not
  drawn, cannot be clicked and is never snapped onto, because it is **wiring,
  not territory** - it holds nothing, produces nothing and cannot start a line.
  Build from a base or your HQ.
- **Crossing an enemy line cuts it.** The severed edge is gone. The server then
  recomputes, from the victim's HQ, what they can still reach. **Everything they
  can no longer reach is captured by you instantly**, stocks reset to zero, and
  wired into your network through your new junction.
- **Redundancy is the counterplay.** If the victim has an alternate route to the
  far side, nothing is captured — only the crossed edge is severed. Building
  loops is how you make your territory un-cuttable.
- **Headquarters can be stormed, but not sniped.** Aim a construction at an
  enemy HQ and the target snaps to its centre, but the assault must be launched
  from within **200px**, costs **2.5x** a normal line, and takes **5x** as long
  to land. That means dragging a chain of relays right up to their door and
  holding it there while the blow lands. Cut the chain underneath an assault
  and it is cancelled, and everything past the cut changes hands.

  The target is **warned the moment the line is started**, not when it lands: a
  banner names the attacker and counts down the seconds left, the assault line
  is drawn thick and pulsing with a ring on the targeted HQ, and everyone else
  sees it in the log. The whole point of making the killing blow slow is that
  it can be answered, which only works if the victim knows.

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
  p2p/             peer-to-peer mode
    protocol.ts      guest <-> host message shapes
    host.ts          HostSession: the authoritative game, in a browser
    peerTransport.ts WebRTC plumbing (PeerJS)
  client/
    transport.ts     the one interface the UI talks to
    camera.ts        zoom/pan maths: fit, clamp, anchored zoom (pure)
    gestures.ts      one pointer state machine for mouse, touch and pen
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
to colour its preview line green or red. The authority runs the same function
and will refuse anything illegal regardless of what the client thinks.

`src/game/` is deliberately free of sockets, DOM and Node built-ins, which is
what lets the exact same simulation run on the server and inside the host
player's browser in P2P mode.

Simulation runs at **20 Hz**; snapshots are broadcast at **10 Hz**. Discrete
events (`constructionStarted`, `supplyLineCut`, `networkCaptured`, `hqCaptured`,
`playerEliminated`, `victory`, ...) are emitted immediately as they happen.
Clients interpolate the construction animation visually and nothing else.

Snapshots are sent as **deltas against the last broadcast**, with a keyframe
every five seconds and whenever anyone joins or reconnects. Full snapshots cost
a client 360 KiB/s in a six-player match, because nearly all of it - positions,
owners, types, and the stock of every node already at capacity - is identical
tick after tick. Both transports guarantee ordered delivery, and a client that
somehow has no base to merge onto waits for the next keyframe rather than
drawing a half-built board. Derivable fields are not sent at all: node capacity
follows from its type, and an edge's length from its endpoints.

### Performance

Measured on a six-player board, before and after:

| | before | after |
| --- | --- | --- |
| Snapshot traffic, settled 246-node board | 360 KiB/s | **9 KiB/s** |
| Snapshot traffic, whole network filling | 357 KiB/s | **91 KiB/s** |
| Server CPU per wall-clock second, 606 nodes | 24.3 ms | **6.7 ms** |
| `room.tick()`, 606 nodes | 1193 us | **320 us** |
| Initial client download | 180 kB (53 kB gzip) | **28 kB (11 kB gzip)** |

Three changes did it. Snapshots became deltas (above). Dijkstra, which ran per
player per tick and was the whole supply pass, moved from an O(V^2) scan to a
binary heap. And the two transports are loaded on demand: socket.io and peerjs
are most of the download, a session only ever uses one of them, and a
peer-to-peer build served from a static host never needs socket.io at all.

On the client, the per-snapshot indexes the renderer and the build preview need
are built once per snapshot instead of once per frame.

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

`spawn.test.ts` checks the seat layout: every polygon edge the same length,
every vertex inside the margin, the polygon grown until a vertex touches that
margin, 2 players spread across the long axis, and a draw that varies between
matches without losing or duplicating a seat.

`junctions.test.ts` pins the inert-junction rules: zero capacity, no stock
however long they are supplied, no income however many a single build mints,
a refusal with a reason when one is used as a build source, never being snapped
onto while aiming, and - the part that must keep working - supply still flowing
through them to what lies beyond.

`delta.test.ts` covers the wire format, including a 400-tick match replay
that builds, captures and deletes nodes and asserts a delta-fed client ends up
byte-identical to one receiving full snapshots.

`camera.test.ts` covers the zoom and pan maths: screen/world round-trips, the
board never being zoomed out past fitting or dragged off screen, an axis that
fully fits staying centred, and the world point under the cursor or pinch
staying put while zooming.

`economy.test.ts` guards against the late-game stall: a 20-node network must
still be able to fund builds, the HQ must not stay drained, income must scale
with supplied territory, and territory that has been cut off must stop paying.

`rush-balance.test.ts` plays the degenerate strategy - sprint one chain of
relays at the enemy HQ - and fails if it can win before a defender could
plausibly answer, if it needs fewer than three relays, if the two headquarters
are not far apart, or if the assault multipliers ever price a headquarters out
of reach of a full base. It also proves the counterplay: one crossing line cuts
the chain and takes everything past the cut.

`p2p-host.test.ts` covers the browser-hosted authority: seating, host-only
start, guests being validated through the same `GameRoom`, malformed and
unknown messages being ignored, snapshot cadence, reconnect windows and what
happens when the host leaves.

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
- **Territory produces income, which the original model did not do.** Flat
  24/s production meant one node and thirty nodes earned exactly the same,
  while every node pulled towards capacity at once. A 20-node network diluted
  that income twenty ways: the HQ sat pinned at zero and **not one node could
  afford even a medium build after 20 seconds** - measured. Both players simply
  ran out of things they were able to do. Supplied nodes now add 4/s each,
  which gives the game an engine to break ties and ties the economy to the core
  mechanic: cutting an enemy network takes their income as well as their
  ground. `tests/economy.test.ts` guards it.
- **The assault warning is derived from the snapshot, not only from an event.**
  Each construction carries the id of the player whose HQ it targets, so the
  banner is right after a reconnect or a dropped packet and clears itself the
  instant the line lands or is cut. The event exists too, for the log.
- **Junctions are invisible and inert, a deliberate break from the original
  spec.** The spec had them store resources and act as build sources, i.e.
  bases that appear for free wherever two of your lines cross. Once supplied
  nodes started paying income, one build across a fan of your own lines minted
  several earners at once. They now hold nothing, earn nothing, cannot start a
  line, are not drawn and are not clickable or snappable - a crossing looks and
  behaves like two lines crossing. The split halves are collinear with the
  originals, so nothing is lost visually. They still conduct, and cutting one
  still severs the network through it.
- **Spawns are the vertices of a regular polygon, drawn at random.** The
  ellipse they replaced was not regular: a 3-player match put two players 576
  apart and the third 979 from both, so the opening was decided by which seat
  you got. All pairs are now equidistant (740 for 3 players). The polygon is
  grown to the largest the map allows rather than a fixed fraction of it, so
  2 players end up 1440 apart across the full width instead of 1248. Because
  every vertex of a regular polygon is equivalent, the draw changes where your
  colour sits, not how good the position is.
- **Isolation is evaluated exactly as specified:** after a cut, any victim-owned
  node not reachable from the victim's HQ is captured.
- **Headquarters spawn far apart, and storming one is deliberately
  expensive.** The original tuning (HQs anchored at the top of the spawn
  ellipse, an HQ assault priced as an ordinary line) made a 2-player match
  winnable in **5.9 seconds with a single relay** - measured, not guessed. Every
  other mechanic was decoration. Spawning along the long axis moved the two HQs
  from 666px to 1248px apart, and the assault limits force a committed chain;
  the same measurement now reads ~22s and three relays, with the chain fully
  exposed to a single crossing line. `tests/rush-balance.test.ts` keeps it
  honest. 3+ player maps stay tighter on purpose - those games are meant to be
  chaotic.
- **Intersections are proper crossings only.** Two lines that merely touch at a
  shared endpoint already meet in the graph, so there is nothing to split; a
  small epsilon keeps floating point from inventing junctions at endpoints, and
  intersections landing within 1.5px of an existing owned node reuse that node
  instead of stacking a duplicate.
- **Snapshots are full state.** At this scale (tens of nodes) delta encoding
  would be pure overhead.
