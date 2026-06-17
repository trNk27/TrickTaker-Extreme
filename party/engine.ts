// Shared authoritative engine layer for the Arcanum game party.
//
// Reuses the SAME browser engine (js/game.js) so live-game rules never diverge
// between client and server. Here we add: the pimc_core serialization contract
// (for the Python PIMC sidecar), DO-storage (de)serialization, the redacted
// per-seat view builder, AI-seat move resolution via the sidecar, and
// round/match progression. Ported from the retired api/game_session.py.

// @ts-ignore - plain CommonJS engine shared with the browser client
import * as GameModule from "../js/game.js";

const G: any = GameModule;
export const ArcanumGame: any = G.ArcanumGame;
export const TRICKS_PER_ROUND = 15;
export const MATCH_ROUNDS = 3; // best-of-3, mirrors single-player
export const COLOR_NAMES: any =
  G.COLOR_NAMES || { 0: "Red", 1: "Blue", 2: "Yellow", 3: "Green", 4: "Purple" };

export type Seat =
  | { type: "human"; playerId: string; nickname: string }
  | { type: "ai"; model: string; pimc: number; nickname: string };

const C5 = [0, 1, 2, 3, 4];

function cardFromId(cid: number) {
  return new G.Card(Math.floor(cid / 9), (cid % 9) + 1);
}

// --------------------------------------------------------------- serialization
// serializeGame() produces EXACTLY the pimc_core contract (the shape that
// api/pimc_core.py deserialize expects, identical to js/pimc.js
// serializeGameState). It carries full hands, so it is also our authoritative
// DO-storage blob — never send it to a client unredacted.
export function serializeGame(g: any) {
  return {
    phase: g.phase,
    tricksPlayed: g.tricksPlayed,
    startingPlayerOffset: g.startingPlayerOffset,
    currentPlayerIdx: g.currentPlayerIdx,
    poolSeals: C5.map((c) => g.poolSeals[c]),
    jokerPool: g.jokerPool,
    roundHistoryMask: Array.from(g.roundHistoryMask),
    currentTrick: g.currentTrick.map((t: any) => [t.playerIdx, t.card.id]),
    pendingLeadColor: g.pendingLeadColor,
    pendingWinCard: g.pendingWinCard ? g.pendingWinCard.id : null,
    lastCompletedTrick: g.lastCompletedTrick ?? null,
    // bidLog powers bidding "undo" (per-turn take/steal history). The pimc_core
    // sidecar ignores this extra key; the party restores it on deserialize.
    bidLog: g.bidLog ?? [],
    players: g.players.map((p: any) => ({
      hand: p.hand.map((c: any) => c.id),
      seals: C5.map((c) => p.seals[c]),
      initialSeals: C5.map((c) => p.initialSeals[c]),
      jokerSeals: p.jokerSeals,
      blackSeals: p.blackSeals,
      hasPassed: p.hasPassedBidding,
      playedMask: Array.from(p.playedCardsMask),
    })),
  };
}

export function deserializeGame(st: any) {
  const g = new G.ArcanumGame();
  g.phase = st.phase;
  g.tricksPlayed = st.tricksPlayed;
  g.startingPlayerOffset = st.startingPlayerOffset;
  g.currentPlayerIdx = st.currentPlayerIdx;
  g.poolSeals = {};
  for (const c of C5) g.poolSeals[c] = st.poolSeals[c];
  g.jokerPool = st.jokerPool;
  g.roundHistoryMask = Array.from(st.roundHistoryMask);
  g.currentTrick = st.currentTrick.map(([pi, cid]: any) => ({
    playerIdx: pi,
    card: cardFromId(cid),
  }));
  g.pendingLeadColor = st.pendingLeadColor;
  g.pendingWinCard = st.pendingWinCard != null ? cardFromId(st.pendingWinCard) : null;
  g.lastCompletedTrick = st.lastCompletedTrick ?? null;
  g.bidLog = Array.isArray(st.bidLog) ? st.bidLog.map((e: any) => ({ ...e })) : [];
  for (let i = 0; i < 3; i++) {
    const pj = st.players[i];
    const p = g.players[i];
    p.hand = pj.hand.map((c: number) => cardFromId(c)).sort((a: any, b: any) => a.id - b.id);
    p.seals = {};
    p.initialSeals = {};
    for (const c of C5) {
      p.seals[c] = pj.seals[c];
      p.initialSeals[c] = pj.initialSeals[c];
    }
    p.jokerSeals = pj.jokerSeals;
    p.blackSeals = pj.blackSeals;
    p.hasPassedBidding = pj.hasPassed;
    p.playedCardsMask = Array.from(pj.playedMask);
  }
  return g;
}

// --------------------------------------------------------------- view building
export function legalActions(g: any, seat: number): number[] {
  const mask = g.getLegalActions(seat);
  const out: number[] = [];
  for (let a = 0; a < mask.length; a++) if (mask[a]) out.push(a);
  return out;
}

// Redacted, ego-centric view for `seat` -- safe to send to that client. Shape
// matches what js/ui.js renderView/hydrateGame/revealTrick already consume.
export function buildView(
  g: any,
  seats: Seat[],
  totalScores: number[],
  matchRound: number,
  status: string,
  version: number,
  seat: number,
  roundScores: number[] | null
) {
  const yourTurn = status === "playing" && g.currentPlayerIdx === seat;
  const players = g.players.map((p: any, i: number) => {
    const entry: any = {
      seat: i,
      type: seats[i].type,
      nickname: (seats[i] as any).nickname ?? `Seat ${i}`,
      seals: C5.map((c) => p.seals[c]),
      initialSeals: C5.map((c) => p.initialSeals[c]),
      jokerSeals: p.jokerSeals,
      blackSeals: p.blackSeals,
      hasPassed: p.hasPassedBidding,
      handCount: p.hand.length,
    };
    if (i === seat) entry.hand = p.hand.map((c: any) => c.id); // only your own hand
    return entry;
  });
  return {
    version,
    status,
    phase: g.phase,
    matchRound,
    matchRounds: MATCH_ROUNDS,
    totalScores: totalScores.map((s) => s | 0),
    yourSeat: seat,
    currentSeat: g.currentPlayerIdx,
    yourTurn,
    players,
    legalActions: yourTurn ? legalActions(g, seat) : [],
    poolSeals: C5.map((c) => g.poolSeals[c]),
    jokerPool: g.jokerPool,
    tricksPlayed: g.tricksPlayed,
    tricksPerRound: TRICKS_PER_ROUND,
    currentTrick: g.currentTrick.map((t: any) => [t.playerIdx, t.card.id]),
    pendingLeadColor: g.pendingLeadColor,
    pendingWinCard: g.pendingWinCard ? g.pendingWinCard.id : null,
    lastTrick: g.lastCompletedTrick, // {winner, cards:[[seat,cardId],...]} | null
    colorNames: COLOR_NAMES,
    roundScores: roundScores ?? null,
  };
}

// --------------------------------------------------------- round / match logic
export function newRoundState(matchRound: number) {
  const g = new G.ArcanumGame();
  g.startingPlayerOffset = matchRound % 3;
  g.reset();
  return g;
}

export function applyRoundResult(scores: number[], total: number[], matchRound: number) {
  const totals = total.map((t, i) => t + scores[i]);
  const nextRound = matchRound + 1;
  return { totals, nextRound, matchDone: nextRound >= MATCH_ROUNDS };
}

// ------------------------------------------------------------------ AI seats
// Resolve one move for an AI (or auto-played) seat via the Python PIMC sidecar.
// pimc_core.choose() (the sidecar) already falls back to greedy for non-PLAYING
// phases, so every AI seat routes through here -- the party never runs ONNX.
// K=1 ~ greedy; K>1 = PIMC search. Falls back to a legal move if the sidecar
// is unreachable so the game can never stall.
export interface AiMoveResult {
  action: number;
  ok: boolean; // true = move came from the sidecar; false = local fallback
  error?: string; // populated when the sidecar call failed (for diagnosis)
}

function firstLegal(g: any, seat: number): number {
  const mask = g.getLegalActions(seat);
  for (let a = 0; a < mask.length; a++) if (mask[a]) return a;
  return 5; // pass — unreachable in a well-formed state
}

export async function aiMove(
  sidecarUrl: string,
  g: any,
  seat: number,
  model: string,
  pimcK: number
): Promise<AiMoveResult> {
  const K = Math.max(1, pimcK || 1);
  try {
    const resp = await fetch(sidecarUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: serializeGame(g), seat, K, model }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { action: firstLegal(g, seat), ok: false, error: `HTTP ${resp.status} ${body}`.trim() };
    }
    const data: any = await resp.json();
    const mask = g.getLegalActions(seat);
    if (typeof data.action !== "number") {
      return { action: firstLegal(g, seat), ok: false, error: "sidecar returned no action" };
    }
    if (!mask[data.action]) {
      return { action: firstLegal(g, seat), ok: false, error: `sidecar returned illegal action ${data.action}` };
    }
    return { action: data.action, ok: true };
  } catch (e: any) {
    return { action: firstLegal(g, seat), ok: false, error: `fetch failed: ${e?.message ?? e}` };
  }
}
