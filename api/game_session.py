"""Server-authoritative orchestration shared by the multiplayer endpoints.

Builds on the existing engine (game_engine.py) and AI (pimc_core.py). Holds the
logic that the browser used to own: advancing AI seats, round/match progression,
and producing a *redacted* per-seat view (a player never sees another hand).

Seats schema (games.seats JSONB), absolute seat order, length 3:
    {"type": "human", "player_id": "<uuid>", "nickname": "Ann"}
    {"type": "ai",    "model": "crusher1", "pimc": 10, "nickname": "Crusher"}

State blob (games.state JSONB) is exactly pimc_core.serialize(game).
"""
import random

import numpy as np

import pimc_core
from game_engine import ArcanumGame, TRICKS_PER_ROUND, COLOR_NAMES

MATCH_ROUNDS = 3        # best-of-3, mirrors the single-player client
_LOOP_CAP = 4000        # safety against a runaway AI loop


# ----------------------------------------------------------------- round setup
def new_round_state(match_round):
    """Fresh dealt round; starting player rotates by round like single-player."""
    g = ArcanumGame()
    g.starting_player_offset = match_round % 3
    g.reset()
    return g


def ai_move(game, seat, seats):
    """Pick a move for an AI seat (or a forced/timed-out seat)."""
    cfg = seats[seat]
    model = cfg.get("model", "crusher1")
    session = pimc_core.get_session(model)
    pimc = cfg.get("pimc")
    if pimc:
        return pimc_core.pimc_action(session, game, seat, int(pimc))
    return pimc_core.onnx_greedy(session, game, seat)


def advance_ai(game, seats):
    """Step every consecutive AI seat until it's a human's turn or the round ends.

    Returns (done, scores|None). Does not handle round/match transitions.
    """
    steps = 0
    while seats[game.current_player_idx]["type"] == "ai":
        action = ai_move(game, game.current_player_idx, seats)
        _, _, done, info = game.step(action)
        steps += 1
        if steps > _LOOP_CAP:
            raise RuntimeError("advance_ai exceeded loop cap")
        if done:
            return True, info["scores"]
    return False, None


def force_seat_move(game, seats):
    """Auto-play the current seat once with greedy AI (idle/timeout substitution).

    Returns (done, scores|None) after that single forced move plus any AI seats
    that follow.
    """
    action = pimc_core.onnx_greedy(pimc_core.get_session(
        seats[game.current_player_idx].get("model", "crusher1")), game,
        game.current_player_idx)
    _, _, done, info = game.step(action)
    if done:
        return True, info["scores"]
    return advance_ai(game, seats)


def apply_round_result(scores, total_scores, match_round):
    """Fold a finished round's scores into the running totals.

    Returns (new_total_scores, new_match_round, match_done).
    """
    totals = [total_scores[i] + scores[i] for i in range(3)]
    next_round = match_round + 1
    return totals, next_round, next_round >= MATCH_ROUNDS


# --------------------------------------------------------------- view building
def legal_actions(game, seat):
    return [int(a) for a in np.flatnonzero(game.get_legal_actions(seat))]


def build_view(game, seats, total_scores, match_round, status, version, seat,
               round_scores=None):
    """Redacted, ego-centric view for `seat` -- safe to send to that client."""
    your_turn = (status == "playing" and game.current_player_idx == seat)
    players = []
    for i, p in enumerate(game.players):
        entry = {
            "seat": i,
            "type": seats[i]["type"],
            "nickname": seats[i].get("nickname", f"Seat {i}"),
            "seals": [int(p.seals[c]) for c in range(5)],
            "initialSeals": [int(p.initial_seals[c]) for c in range(5)],
            "jokerSeals": int(p.joker_seals),
            "blackSeals": int(p.black_seals),
            "hasPassed": bool(p.has_passed_bidding),
            "handCount": len(p.hand),
        }
        if i == seat:                       # only ever expose *your own* hand
            entry["hand"] = [int(c.id) for c in p.hand]
        players.append(entry)

    return {
        "version": int(version),
        "status": status,                   # 'playing' | 'done'
        "phase": game.phase,
        "matchRound": int(match_round),
        "matchRounds": MATCH_ROUNDS,
        "totalScores": [int(s) for s in total_scores],
        "yourSeat": int(seat),
        "currentSeat": int(game.current_player_idx),
        "yourTurn": your_turn,
        "players": players,
        "legalActions": legal_actions(game, seat) if your_turn else [],
        "poolSeals": [int(game.pool_seals[c]) for c in range(5)],
        "jokerPool": int(game.joker_pool),
        "tricksPlayed": int(game.tricks_played),
        "tricksPerRound": TRICKS_PER_ROUND,
        "currentTrick": [[int(pi), int(card.id)] for pi, card in game.current_trick],
        "pendingLeadColor": game.pending_lead_color,
        "pendingWinCard": (int(game.pending_win_card.id)
                           if getattr(game, "pending_win_card", None) is not None else None),
        "lastTrick": getattr(game, "last_completed_trick", None),
        "colorNames": COLOR_NAMES,
        "roundScores": ([int(s) for s in round_scores] if round_scores else None),
    }
