# Arcanum online multiplayer (PartyKit)

Live games run on **PartyKit** (persistent WebSocket rooms on Cloudflare Durable
Objects). The server is authoritative and **pushes** a redacted per-seat view
after every move — no polling. AI seats are resolved by the **Python PIMC
sidecar** (`../api/pimc-move.py`, deployed on Vercel), so the edge runtime never
runs ONNX.

## Pieces

| File | Role |
|------|------|
| `game.ts`   | Game party — one Durable Object per room. Pre-game **lobby** (host seat config), then authoritative **playing** loop. Validates human moves, runs AI seats via the sidecar with a visible `thinking` broadcast, handles best-of-3 progression + idle timeout (DO alarm), persists to DO storage (survives hibernation / supports resume). |
| `lobby.ts`  | Quick-match queue (one well-known room `main`). Pairs 3 humans, or fills with AI on request, provisions a game room via HTTP, and tells matched clients which room to join. |
| `engine.ts` | Shared layer over the **same** browser engine (`../js/game.js`) — no rules duplication. Holds the `pimc_core` serialization contract, DO (de)serialization, the redacted view builder, and the sidecar call. Ported from the retired `api/game_session.py`. |

Client transport lives in `../js/online.js` (PartySocket). The browser applies
its **own** move optimistically and reconciles on the next pushed view.

## Identity

A persistent random `playerId` (browser `localStorage.we_pid`) is the bearer for
a player's seat in a room. Reconnecting with it resumes the seat. It is never
shown to other players (same threat model as the old server-issued token).

## Run locally

```bash
cd webapp
npm install
# terminal 1 — PIMC sidecar (needs the project's Python env with onnxruntime)
npm run sidecar                 # serves http://127.0.0.1:3000/api/pimc-move
# terminal 2 — PartyKit dev (serves party + the static site on :1999)
npm run dev                     # http://127.0.0.1:1999
```

`partykit.json` `vars.PIMC_SIDECAR_URL` points the party at the sidecar (defaults
to the local one above). The static site auto-connects to `127.0.0.1:1999` unless
`window.PARTYKIT_HOST` is set in `index.html`.

## Tests

```bash
npm run typecheck       # tsc on party/*.ts
npm run test:contract   # JS engine vs Python engine parity across a full match
npm run e2e             # drives a full match against a running `npm run dev` + sidecar
```

## Deploy

1. **Sidecar** (Vercel, Python): `api/pimc-move.py` + `pimc_core.py` +
   `game_engine.py` + `models/`. `vercel.json` exposes only `pimc-move`.
2. **Party** (Cloudflare/PartyKit): `npm run deploy`. Set the production sidecar
   URL: `npx partykit env add PIMC_SIDECAR_URL` (or `vars` in `partykit.json`).
3. **Frontend**: set `window.PARTYKIT_HOST` in `index.html` to the deployed party
   host, then deploy the static site as usual (the `trNk27/TrickTaker-Extreme`
   repo / Vercel).
