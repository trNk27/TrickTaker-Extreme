// Arcanum game party — authoritative, one Durable Object per room.
//
// A room moves through three phases:
//   "lobby"   — host configures the 3 seats (Open for a human, or an AI model+K),
//               friends join via the room code and claim Open seats, host starts.
//   "playing" — server-authoritative engine; humans submit moves, AI seats are
//               resolved via the Python PIMC sidecar with a visible "thinking"
//               broadcast. State persists in DO storage (survives hibernation).
//   "done"    — match (best-of-3) finished.
//
// Transport is push: every applied move broadcasts a fresh redacted per-seat
// view, so there is no polling. The client applies its OWN move optimistically
// and reconciles on the next view.
//
// Runtime: a Cloudflare Durable Object via `partyserver` (deployed with wrangler
// to your own Cloudflare account). Identity: the browser holds a persistent
// random playerId (localStorage) — bearer for that player's seat; reconnecting
// with it resumes the seat.
import { Server, type Connection, type ConnectionContext } from "partyserver";
import {
  serializeGame,
  deserializeGame,
  buildView,
  newRoundState,
  applyRoundResult,
  aiMove,
  type Seat,
} from "./engine";

export interface Env {
  PIMC_SIDECAR_URL: string;
  Game: DurableObjectNamespace;
  Lobby: DurableObjectNamespace;
}

const TURN_TIMEOUT_MS = 45_000; // idle human seat auto-played after this
// PIMC depth for "smart bidding" (bid-phase search) when a seat enables it.
// Modest on purpose: a bid turn fires one search per seal taken.
const SMART_BID_K = 5;
const DEFAULT_AI = { model: "crusher1", pimc: 10, bidK: 0, nickname: "Crusher" };

type OpenSlot = { type: "open" };
type SlotConfig = OpenSlot | Seat; // lobby-phase seat config (may contain "open")

interface RoomState {
  status: "lobby" | "playing" | "done";
  hostId: string | null;
  config: SlotConfig[]; // length 3 (lobby phase)
  seats: Seat[]; // length 3, resolved at start (no "open")
  players: Record<string, string>; // playerId -> nickname (humans seen)
  game: any | null; // serializeGame blob (null while in lobby)
  totalScores: number[];
  matchRound: number;
  lastRoundScores: number[] | null;
  version: number;
  lastActionAt: number;
}

// Allowed AI models (must match the sidecar's ALLOWED_MODELS) and their display
// nicknames. Search depth K is chosen separately by the host.
const AI_MODELS: Record<string, string> = {
  minty1: "Minty",
  kingston2: "Kingston",
  crusher1: "Crusher",
};
const ALLOWED_K = [1, 5, 10, 20];

// Build a validated AI seat from a {model, pimc, smartBid} config, or null if
// invalid. smartBid (truthy) turns on bid-phase PIMC search at SMART_BID_K.
function aiSeatFrom(model: string, pimc: number, smartBid: boolean): Seat | null {
  if (!AI_MODELS[model]) return null;
  const K = ALLOWED_K.includes(pimc) ? pimc : 10;
  const bidK = smartBid ? SMART_BID_K : 0;
  const depth = K === 1 ? "greedy" : `K=${K}`;
  const tag = bidK ? " · smart bid" : "";
  return { type: "ai", model, pimc: K, bidK, nickname: `${AI_MODELS[model]} · ${depth}${tag}` };
}

export class Game extends Server<Env> {
  state: RoomState | null = null;

  // ---------------------------------------------------------------- lifecycle
  async onStart() {
    this.state = (await this.ctx.storage.get<RoomState>("room")) ?? null;
  }

  private async save() {
    await this.ctx.storage.put("room", this.state);
  }

  private sidecarUrl(): string {
    return this.env.PIMC_SIDECAR_URL || "http://127.0.0.1:3000/api/pimc-move";
  }

  // Fresh lobby room created by the first connector (the host).
  private freshLobby(hostId: string, nickname: string): RoomState {
    return {
      status: "lobby",
      hostId,
      // Host sits at seat 0 by default; the other two start Open.
      config: [{ type: "human", playerId: hostId, nickname }, { type: "open" }, { type: "open" }],
      seats: [],
      players: { [hostId]: nickname },
      game: null,
      totalScores: [0, 0, 0],
      matchRound: 0,
      lastRoundScores: null,
      version: 0,
      lastActionAt: Date.now(),
    };
  }

  // ---------------------------------------------------------------- connect
  async onConnect(conn: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    const playerId = url.searchParams.get("pid") || "";
    const nickname = (url.searchParams.get("nick") || "Player").slice(0, 20) || "Player";
    if (!playerId) {
      conn.send(JSON.stringify({ type: "error", error: "missing player id" }));
      return conn.close();
    }
    conn.setState({ playerId });

    if (!this.state) {
      // First connector creates + hosts the room.
      this.state = this.freshLobby(playerId, nickname);
      await this.save();
    } else if (this.seatOf(playerId) === null) {
      // Not yet seated.
      if (this.state.status === "lobby") {
        const open = this.state.config.findIndex((s) => s.type === "open");
        if (open === -1) {
          conn.send(JSON.stringify({ type: "error", error: "room is full" }));
          return conn.close();
        }
        this.state.config[open] = { type: "human", playerId, nickname };
        this.state.players[playerId] = nickname;
        await this.save();
        this.broadcastLobby();
      } else {
        // Game already started and this player has no seat — spectating isn't
        // supported; send them back.
        conn.send(JSON.stringify({ type: "error", error: "match already in progress" }));
        return conn.close();
      }
    }

    // Send the appropriate current state to just this connection.
    if (this.state.status === "lobby") this.sendLobby(conn);
    else this.sendView(conn);
  }

  // Seat index for a playerId in the *resolved or lobby* config, or null.
  private seatOf(playerId: string): number | null {
    if (!this.state) return null;
    const arr: any[] = this.state.status === "lobby" ? this.state.config : this.state.seats;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].type === "human" && arr[i].playerId === playerId) return i;
    }
    return null;
  }

  // ---------------------------------------------------------------- messages
  async onMessage(sender: Connection, message: string) {
    let msg: any;
    try {
      msg = JSON.parse(message as string);
    } catch {
      return;
    }
    const playerId = (sender.state as any)?.playerId as string;
    if (!playerId || !this.state) return;

    switch (msg.type) {
      case "configSeat":
        return this.onConfigSeat(playerId, msg);
      case "start":
        return this.onStartMatch(playerId);
      case "move":
        return this.onMove(playerId, msg);
      case "undo":
        return this.onUndo(playerId, msg);
      case "abandon":
        return this.onAbandon(playerId);
    }
  }

  // ---- lobby: host edits a seat ----
  private async onConfigSeat(playerId: string, msg: any) {
    const s = this.state!;
    if (s.status !== "lobby" || playerId !== s.hostId) return;
    const seat = msg.seat | 0;
    if (seat < 0 || seat > 2) return;
    if (s.config[seat].type === "human") return; // can't reassign an occupied human seat
    if (msg.value === "open") {
      s.config[seat] = { type: "open" };
    } else if (msg.value && typeof msg.value === "object") {
      const seatCfg = aiSeatFrom(String(msg.value.model), msg.value.pimc | 0, !!msg.value.smartBid);
      if (!seatCfg) return;
      s.config[seat] = seatCfg;
    } else {
      return;
    }
    await this.save();
    this.broadcastLobby();
  }

  // ---- lobby: host starts the match ----
  private async onStartMatch(playerId: string) {
    const s = this.state!;
    if (s.status !== "lobby" || playerId !== s.hostId) return;
    // Resolve the config into final seats; any leftover Open seats become the
    // default AI fill.
    s.seats = s.config.map((c) =>
      c.type === "open" ? ({ type: "ai", ...DEFAULT_AI } as Seat) : (c as Seat)
    );
    s.status = "playing";
    s.matchRound = 0;
    s.totalScores = [0, 0, 0];
    s.lastRoundScores = null;
    const g = newRoundState(0);
    s.game = serializeGame(g);
    s.version++;
    s.lastActionAt = Date.now();
    await this.save();
    this.broadcastViews(); // push the opening deal (esp. when seat 0 leads as a human)
    // Lead AI seats (if seat 0 is AI) before the first human decision.
    await this.runUntilHumanOrEnd();
  }

  // ---- play: a human submits a move ----
  private async onMove(playerId: string, msg: any) {
    const s = this.state!;
    if (s.status !== "playing") return;
    const seat = this.seatOf(playerId);
    if (seat === null) return;
    const g = deserializeGame(s.game);
    if (g.currentPlayerIdx !== seat) {
      return this.sendErrorTo(playerId, "not your turn");
    }
    const action = msg.action | 0;
    const mask = g.getLegalActions(seat);
    if (action < 0 || action >= mask.length || !mask[action]) {
      return this.sendErrorTo(playerId, "illegal move");
    }

    const res = g.step(action);
    this.commitStep(g, res); // updates game/scores/round, bumps version
    await this.save();
    this.broadcastViews(); // instant ack of the human's own move + opponents see it
    if (s.status === "playing") await this.runUntilHumanOrEnd();
    else this.afterDone();
  }

  // ---- play: undo a bidding take/steal of `color` (your own turn only) ----
  private async onUndo(playerId: string, msg: any) {
    const s = this.state!;
    if (s.status !== "playing") return;
    const seat = this.seatOf(playerId);
    if (seat === null) return;
    const g = deserializeGame(s.game);
    if (g.currentPlayerIdx !== seat || g.phase !== "BIDDING") return;
    if (!g.undoSeal(msg.color | 0)) return; // nothing to undo
    // Undo never changes whose turn it is and never ends a round → no AI loop.
    s.version++;
    s.lastActionAt = Date.now();
    s.game = serializeGame(g);
    await this.save();
    this.broadcastViews();
  }

  private async onAbandon(playerId: string) {
    if (this.seatOf(playerId) === null) return;
    this.bcast({ type: "ended", reason: "abandoned" });
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete("room");
    this.state = null;
  }

  // -------------------------------------------------- engine step accounting
  // Fold a single step result into room state: handle round end, match end,
  // and dealing the next round. Mirrors the retired game_store._progress.
  private commitStep(g: any, res: any) {
    const s = this.state!;
    s.version++;
    s.lastActionAt = Date.now();
    if (!res.done) {
      s.game = serializeGame(g);
      return;
    }
    const scores: number[] = res.info.scores;
    s.lastRoundScores = scores.map((x) => x | 0);
    const { totals, nextRound, matchDone } = applyRoundResult(scores, s.totalScores, s.matchRound);
    s.totalScores = totals;
    if (matchDone) {
      s.status = "done";
      s.game = serializeGame(g); // keep final round state (final trick visible)
    } else {
      s.matchRound = nextRound;
      const ng = newRoundState(nextRound);
      s.game = serializeGame(ng);
    }
  }

  // Resolve consecutive AI seats until a human must act (or the match ends),
  // broadcasting a "thinking" hint and then a fresh view after each AI move so
  // humans see opponents play one at a time.
  private async runUntilHumanOrEnd() {
    const s = this.state!;
    let guard = 0;
    while (s.status === "playing") {
      const g = deserializeGame(s.game);
      const seat = g.currentPlayerIdx;
      const cfg = s.seats[seat];
      if (cfg.type === "human") break;
      if (++guard > 4000) throw new Error("AI loop cap exceeded");

      this.bcast({
        type: "thinking",
        seat,
        nickname: cfg.nickname,
        model: cfg.model,
        pimc: cfg.pimc,
      });
      const mv = await aiMove(this.sidecarUrl(), g, seat, cfg.model, cfg.pimc, cfg.bidK ?? 0);
      if (!mv.ok) this.reportSidecarFailure(seat, cfg, mv.error);
      const res = g.step(mv.action);
      this.commitStep(g, res);
      await this.save();
      this.broadcastViews();
    }
    if (s.status === "playing") this.armTimeout();
    else this.afterDone();
  }

  private afterDone() {
    // Match over: stop the idle alarm; the views already carry status "done".
    this.ctx.storage.deleteAlarm();
  }

  // -------------------------------------------------------------- idle timeout
  private armTimeout() {
    this.ctx.storage.setAlarm(Date.now() + TURN_TIMEOUT_MS);
  }

  async onAlarm() {
    const s = this.state;
    if (!s || s.status !== "playing") return;
    if (Date.now() - s.lastActionAt < TURN_TIMEOUT_MS) {
      // Activity happened after the alarm was set; re-arm for the remainder.
      return this.armTimeout();
    }
    const g = deserializeGame(s.game);
    const seat = g.currentPlayerIdx;
    if (s.seats[seat].type !== "human") return; // only humans time out
    // Auto-play the idle human with a quick greedy move, then resume the AI loop.
    this.bcast({ type: "thinking", seat, nickname: "(idle)", model: DEFAULT_AI.model, pimc: 1 });
    const mv = await aiMove(this.sidecarUrl(), g, seat, DEFAULT_AI.model, 1);
    if (!mv.ok) this.reportSidecarFailure(seat, { model: DEFAULT_AI.model, pimc: 1 }, mv.error);
    const res = g.step(mv.action);
    this.commitStep(g, res);
    await this.save();
    this.broadcastViews();
    if (s.status === "playing") await this.runUntilHumanOrEnd();
    else this.afterDone();
  }

  // Surface a sidecar failure loudly: log it in the party (visible in
  // `wrangler dev` output / Cloudflare logs) and broadcast a one-shot warning to
  // clients so it's obvious the AI is on fallback moves, not real PIMC/greedy.
  private warnedSidecar = false;
  private reportSidecarFailure(seat: number, cfg: any, error?: string) {
    const url = this.sidecarUrl();
    console.error(
      `[Arcanum] PIMC sidecar call FAILED for seat ${seat} (model=${cfg?.model}, K=${cfg?.pimc}) ` +
        `at ${url}: ${error}. Playing a fallback legal move instead.`
    );
    if (!this.warnedSidecar) {
      this.warnedSidecar = true; // one banner per room, not per move
      this.bcast({
        type: "warning",
        error: `AI move server (PIMC sidecar) unreachable at ${url} — opponents are playing ` +
          `weak fallback moves. Details: ${error}`,
      });
    }
  }

  // --------------------------------------------------------- HTTP (quick match)
  // The lobby party initializes a quick-match room here: it has already picked
  // seats (humans with their playerIds + AI fill). We deal and start immediately.
  async onRequest(request: Request) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body: any = await request.json();
    const seats: Seat[] = body.seats;
    if (!Array.isArray(seats) || seats.length !== 3) {
      return new Response(JSON.stringify({ error: "bad seats" }), { status: 400 });
    }
    const players: Record<string, string> = {};
    for (const st of seats) if (st.type === "human") players[st.playerId] = st.nickname;
    const g = newRoundState(0);
    this.state = {
      status: "playing",
      hostId: null,
      config: [],
      seats,
      players,
      game: serializeGame(g),
      totalScores: [0, 0, 0],
      matchRound: 0,
      lastRoundScores: null,
      version: 1,
      lastActionAt: Date.now(),
    };
    await this.save();
    this.broadcastViews(); // push the opening deal before resolving any AI seats
    await this.runUntilHumanOrEnd();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ---------------------------------------------------------------- broadcast
  private lobbyPayload() {
    const s = this.state!;
    return {
      type: "lobby",
      roomId: this.name,
      hostId: s.hostId,
      seats: s.config.map((c, i) => ({
        seat: i,
        type: c.type,
        nickname: (c as any).nickname ?? null,
        model: (c as any).model ?? null,
        pimc: (c as any).pimc ?? null,
        bidK: (c as any).bidK ?? 0,
      })),
    };
  }

  private sendLobby(conn: Connection) {
    const playerId = (conn.state as any)?.playerId;
    conn.send(
      JSON.stringify({
        ...this.lobbyPayload(),
        yourPlayerId: playerId,
        youAreHost: playerId === this.state!.hostId,
        yourSeat: this.seatOf(playerId),
      })
    );
  }

  private broadcastLobby() {
    for (const conn of this.getConnections()) this.sendLobby(conn);
  }

  private sendView(conn: Connection) {
    const s = this.state!;
    if (!s.game) return;
    const playerId = (conn.state as any)?.playerId;
    const seat = this.seatOf(playerId);
    if (seat === null) return;
    const g = deserializeGame(s.game);
    const view = buildView(
      g,
      s.seats,
      s.totalScores,
      s.matchRound,
      s.status,
      s.version,
      seat,
      s.lastRoundScores
    );
    conn.send(JSON.stringify({ type: "view", view }));
  }

  private broadcastViews() {
    for (const conn of this.getConnections()) this.sendView(conn);
  }

  // Broadcast a JSON object to every connection (wraps Server.broadcast, which
  // takes a string). Named `bcast` to avoid overriding the inherited method.
  private bcast(obj: any) {
    this.broadcast(JSON.stringify(obj));
  }

  private sendErrorTo(playerId: string, error: string) {
    for (const conn of this.getConnections()) {
      if ((conn.state as any)?.playerId === playerId) {
        conn.send(JSON.stringify({ type: "error", error }));
      }
    }
  }
}
