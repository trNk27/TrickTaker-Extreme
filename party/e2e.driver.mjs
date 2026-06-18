// End-to-end driver: hosts a private room on the local `partykit dev` server,
// configures the two opponent seats as AI, starts, and plays seat 0 to the end
// of a best-of-3 match by always answering with a legal action. Asserts the
// lobby/seat-config/start/AI-loop/round-transition/match-end path all work and
// that "thinking" hints arrive (PIMC visible). Uses node 22's global WebSocket
// via partysocket.
import { PartySocket } from "partysocket";

const HOST = process.env.PK_HOST || "127.0.0.1:1999";
const ROOM = "e2e-" + Math.random().toString(36).slice(2, 8);
const PID = "host-" + Math.random().toString(36).slice(2, 8);

let started = false;
let thinkingSeen = 0;
let lastVersion = -1;
let viewsSeen = 0;
let resolved = false;

const sock = new PartySocket({ host: HOST, party: "game", room: ROOM,
  query: { pid: PID, nick: "Host" } });

function send(obj) { sock.send(JSON.stringify(obj)); }

const timeout = setTimeout(() => fail("timed out waiting for match to finish"), 60_000);

function done(ok, msg) {
  if (resolved) return;
  resolved = true;
  clearTimeout(timeout);
  console.log(msg);
  sock.close();
  process.exit(ok ? 0 : 1);
}
function fail(m) { done(false, "E2E FAIL: " + m); }

sock.addEventListener("error", (e) => fail("socket error " + (e?.message || "")));

sock.addEventListener("message", (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }

  if (m.type === "lobby") {
    if (m.youAreHost && !started) {
      // Configure the two non-host seats (model/K overridable via env for timing).
      const model = process.env.AI_MODEL || "minty1";
      const pimc = parseInt(process.env.AI_K || "1");
      const smartBid = process.env.AI_SMARTBID === "1"; // exercise bid-phase PIMC
      for (const s of m.seats) {
        if (s.seat !== m.yourSeat)
          send({ type: "configSeat", seat: s.seat, value: { model, pimc, smartBid } });
      }
      started = true;
      setTimeout(() => send({ type: "start" }), 200);
    }
    return;
  }

  if (m.type === "thinking") { thinkingSeen++; return; }

  if (m.type === "view") {
    const v = m.view;
    viewsSeen++;
    if (typeof v.version === "number") {
      if (v.version < lastVersion) return; // stale
      lastVersion = v.version;
    }
    if (v.status === "done") {
      const total = v.totalScores;
      const okScores = Array.isArray(total) && total.length === 3 && total.some((x) => x !== 0);
      if (thinkingSeen === 0) return fail("no 'thinking' hints arrived (PIMC not visible)");
      if (!okScores) return fail("match done but totalScores look empty: " + JSON.stringify(total));
      return done(true, `E2E OK — match complete. views=${viewsSeen} thinking=${thinkingSeen} totals=${JSON.stringify(total)}`);
    }
    if (v.yourTurn) {
      const legal = v.legalActions || [];
      if (!legal.length) return fail("my turn but no legal actions");
      // Pick a deterministic legal action.
      send({ type: "move", action: legal[0], version: v.version });
    }
    return;
  }

  if (m.type === "error") return fail("server error: " + m.error);
  if (m.type === "ended") return fail("unexpected 'ended': " + m.reason);
});
