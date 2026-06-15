"""Transactional game progression for the multiplayer endpoints.

Holds the authoritative move application and the lazy idle/disconnect timeout.
Both run under a FOR UPDATE lock on the game row so concurrent invocations can't
double-apply. View building lives in game_session.build_view.
"""
import json
from datetime import datetime, timezone

import pimc_core
import game_session
from db import tx, query

TURN_TIMEOUT_SEC = 30      # idle human seat is auto-played by AI after this


class MoveError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


def _seat_for_token(seats, player_id):
    for i, s in enumerate(seats):
        if s.get("type") == "human" and str(s.get("player_id")) == str(player_id):
            return i
    return None


def _player_id_for_token(token):
    row = query("SELECT id FROM players WHERE token = %s", (token,), fetch="one")
    return row["id"] if row else None


def _persist(cur, game_id, game, seats, status, total_scores, match_round,
             round_scores):
    # round_scores is set only on the move that ends a round; otherwise keep the
    # previous value so polling clients can still read the latest summary.
    cur.execute(
        "UPDATE games SET state = %s, seats = %s, current_seat = %s, status = %s, "
        "match_round = %s, total_scores = %s, "
        "last_round_scores = COALESCE(%s::jsonb, last_round_scores), "
        "version = version + 1, last_action_at = now(), updated_at = now() "
        "WHERE id = %s",
        (json.dumps(pimc_core.serialize(game)), json.dumps(seats),
         game.current_player_idx, status, match_round,
         json.dumps([int(s) for s in total_scores]),
         (json.dumps([int(s) for s in round_scores]) if round_scores else None),
         game_id))


def _progress(cur, row, game, seats, done, scores):
    """Advance AI seats and handle round/match transitions, then persist.

    `done`/`scores` describe the move that was just applied (round end or not).
    Returns the kwargs needed to build the view.
    """
    total = list(row["total_scores"])
    match_round = row["match_round"]
    status = "playing"
    round_scores = None

    if not done:
        done, scores = game_session.advance_ai(game, seats)

    if done:
        round_scores = [int(s) for s in scores]
        total, next_round, match_done = game_session.apply_round_result(
            scores, total, match_round)
        if match_done:
            status = "done"
        else:
            match_round = next_round
            game = game_session.new_round_state(match_round)
            game_session.advance_ai(game, seats)   # lead AI seats in the new round

    _persist(cur, row["id"], game, seats, status, total, match_round, round_scores)
    return {
        "game": game, "seats": seats, "status": status, "total_scores": total,
        "match_round": match_round, "version": row["version"] + 1,
        "round_scores": round_scores,
    }


def apply_move(game_id, token, action):
    """Validate and apply a human move, then advance to the next human decision."""
    with tx() as cur:
        cur.execute("SELECT * FROM games WHERE id = %s FOR UPDATE", (game_id,))
        row = cur.fetchone()
        if not row:
            raise MoveError(404, "game not found")
        player_id = _player_id_for_token(token)
        seat = _seat_for_token(row["seats"], player_id)
        if seat is None:
            raise MoveError(403, "not a player in this game")
        if row["status"] != "playing":
            raise MoveError(409, "game is over")

        game = pimc_core.deserialize(row["state"])
        if game.current_player_idx != seat:
            raise MoveError(409, "not your turn")
        mask = game.get_legal_actions(seat)
        if action < 0 or action >= len(mask) or not mask[action]:
            raise MoveError(400, f"illegal action {action}")

        _, _, done, info = game.step(action)
        scores = info.get("scores") if done else None
        result = _progress(cur, row, game, row["seats"], done, scores)
        return game_session.build_view(
            result["game"], result["seats"], result["total_scores"],
            result["match_round"], result["status"], result["version"], seat,
            round_scores=result["round_scores"])


def maybe_timeout(game_id):
    """If the current human seat has been idle past the timeout, auto-play it.

    Returns True if a substitution happened. Called from state polls so a
    disconnected player can't stall the game.
    """
    with tx() as cur:
        cur.execute("SELECT * FROM games WHERE id = %s FOR UPDATE", (game_id,))
        row = cur.fetchone()
        if not row or row["status"] != "playing":
            return False
        seats = row["seats"]
        game = pimc_core.deserialize(row["state"])
        seat = game.current_player_idx
        if seats[seat]["type"] != "human":
            return False
        idle = (datetime.now(timezone.utc) - row["last_action_at"]).total_seconds()
        if idle <= TURN_TIMEOUT_SEC:
            return False
        # Force one greedy move for the idle seat, then advance normally.
        action = pimc_core.onnx_greedy(
            pimc_core.get_session(seats[seat].get("model", "crusher1")), game, seat)
        _, _, done, info = game.step(action)
        scores = info.get("scores") if done else None
        _progress(cur, row, game, seats, done, scores)
        return True


def get_view(game_id, token, since=-1):
    """Read-only ego-centric view. Applies a lazy timeout first if needed."""
    player_id = _player_id_for_token(token)
    if player_id is None:
        raise MoveError(403, "bad token")
    row = query("SELECT * FROM games WHERE id = %s", (game_id,), fetch="one")
    if not row:
        raise MoveError(404, "game not found")
    seat = _seat_for_token(row["seats"], player_id)
    if seat is None:
        raise MoveError(403, "not a player in this game")

    # Lazy disconnect handling: if the seat to move is an idle human, sub it.
    if row["status"] == "playing" and row["seats"][row["current_seat"]]["type"] == "human":
        if maybe_timeout(game_id):
            row = query("SELECT * FROM games WHERE id = %s", (game_id,), fetch="one")

    if int(row["version"]) <= int(since):
        return {"changed": False, "version": int(row["version"])}

    game = pimc_core.deserialize(row["state"])
    view = game_session.build_view(
        game, row["seats"], row["total_scores"], row["match_round"],
        row["status"], row["version"], seat,
        round_scores=row.get("last_round_scores"))
    view["changed"] = True
    return view
