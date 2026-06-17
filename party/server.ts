// Cloudflare Worker entry for the Arcanum realtime backend (partyserver).
//
// Routes `/parties/:party/:room` to the right Durable Object:
//   party "game"  -> Game  DO (one per room/code)
//   party "lobby" -> Lobby DO (quick-match queue; room "main")
// The static site is served by Vercel; this Worker is realtime-only.
import { routePartykitRequest } from "partyserver";
import type { Env } from "./game";

export { Game } from "./game";
export { Lobby } from "./lobby";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env as any)) ||
      new Response("Not found", { status: 404 })
    );
  },
};
