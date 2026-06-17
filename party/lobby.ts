// Arcanum lobby party — a single well-known room ("main") that runs the quick
// "Find Match" queue. It pairs up to 3 waiting humans (or fills with AI on a
// player's request), provisions a fresh game room by POSTing the resolved seats
// to that game Durable Object, and tells the matched clients which room to join.
//
// Host-configured private rooms do NOT go through here — those connect directly
// to a game room by code and configure seats there.
import { Server, type Connection, getServerByName } from "partyserver";
import type { Env } from "./game";

const DEFAULT_AI = { type: "ai" as const, model: "crusher1", pimc: 10, nickname: "Crusher" };

interface Waiter {
  connId: string;
  playerId: string;
  nickname: string;
}

type HumanSeat = { type: "human"; playerId: string; nickname: string };
type Seat = HumanSeat | typeof DEFAULT_AI;

export class Lobby extends Server<Env> {
  waiting: Waiter[] = [];

  onClose(conn: Connection) {
    this.waiting = this.waiting.filter((w) => w.connId !== conn.id);
    this.broadcastCount();
  }

  async onMessage(sender: Connection, message: string) {
    let msg: any;
    try {
      msg = JSON.parse(message as string);
    } catch {
      return;
    }
    const playerId = msg.playerId || (sender.state as any)?.playerId;
    const nickname = (msg.nickname || "Player").slice(0, 20) || "Player";
    if (!playerId) return;
    sender.setState({ playerId });

    if (msg.type === "queue") {
      if (!this.waiting.some((w) => w.playerId === playerId)) {
        this.waiting.push({ connId: sender.id, playerId, nickname });
      }
      if (this.waiting.length >= 3) {
        await this.makeMatch(this.waiting.slice(0, 3), /*fillAi*/ false);
      } else {
        this.broadcastCount();
      }
    } else if (msg.type === "fill") {
      // Start now with whoever's waiting (self first), fill the rest with AI.
      const self: Waiter = { connId: sender.id, playerId, nickname };
      const others = this.waiting.filter((w) => w.playerId !== playerId).slice(0, 2);
      await this.makeMatch([self, ...others], /*fillAi*/ true);
    }
  }

  private async makeMatch(humans: Waiter[], fillAi: boolean) {
    if (!fillAi && humans.length < 3) return;
    const roomId = randomCode();

    // Random seat assignment, like the old matchmaking.create_game.
    const order = shuffle([0, 1, 2]);
    const seats: Seat[] = [DEFAULT_AI, DEFAULT_AI, DEFAULT_AI].slice() as Seat[];
    humans.slice(0, 3).forEach((h, i) => {
      seats[order[i]] = { type: "human", playerId: h.playerId, nickname: h.nickname };
    });

    // Provision + start the game room (same DO the clients will connect to:
    // getServerByName uses idFromName(roomId), matching routePartykitRequest).
    let ok = false;
    try {
      const stub = await getServerByName(this.env.Game, roomId);
      const resp = await stub.fetch("https://arcanum.internal/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seats }),
      });
      ok = resp.ok;
    } catch (e) {
      console.error("[Arcanum] lobby failed to provision game room:", e);
    }
    if (!ok) {
      for (const h of humans) this.sendTo(h.connId, { type: "error", error: "matchmaking failed" });
      return;
    }

    const matchedIds = new Set(humans.map((h) => h.playerId));
    this.waiting = this.waiting.filter((w) => !matchedIds.has(w.playerId));
    for (const h of humans) this.sendTo(h.connId, { type: "matched", roomId });
    this.broadcastCount();
  }

  private broadcastCount() {
    this.broadcast(JSON.stringify({ type: "waiting", count: this.waiting.length }));
  }

  private sendTo(connId: string, obj: any) {
    const conn = this.getConnection(connId);
    if (conn) conn.send(JSON.stringify(obj));
  }
}

function randomCode(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
