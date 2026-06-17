"""Integration test of game_store with an in-memory fake of the db layer.

Exercises the REAL apply_move / get_view / maybe_timeout code paths (move
validation, server-side AI advancement, round + match transitions, view
redaction, version bumping, idle timeout) without needing Postgres. The DB-
specific SQL in matchmaking is covered separately by the live Neon run.

Run:  cd webapp && python test_game_store_fake.py
"""
import json
import os
import random
import sys
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "api"))

# Stub psycopg so db.py imports cleanly; we replace tx/query with fakes below.
import types
_pg = types.ModuleType("psycopg")
_pg_rows = types.ModuleType("psycopg.rows")
_pg_rows.dict_row = object()
_pg.rows = _pg_rows
_pg.connect = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no db in test"))
sys.modules["psycopg"] = _pg
sys.modules["psycopg.rows"] = _pg_rows

import pimc_core
import game_session as gs
import game_store

# ---- in-memory stand-ins for the two tables game_store touches ----
GAMES = {}
PLAYERS = {"tok-human": "p-human"}   # token -> player_id


class FakeCursor:
    def __init__(self):
        self.result = None

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        if s.startswith("SELECT * FROM games") and "FOR UPDATE" in s:
            self.result = dict(GAMES[params[-1]])
        elif s.startswith("UPDATE games SET"):
            gid = params[-1]
            row = GAMES[gid]
            row["state"] = json.loads(params[0])
            row["seats"] = json.loads(params[1])
            row["current_seat"] = params[2]
            row["status"] = params[3]
            row["match_round"] = params[4]
            row["total_scores"] = json.loads(params[5])
            if params[6] is not None:
                row["last_round_scores"] = json.loads(params[6])
            row["version"] += 1
            row["last_action_at"] = datetime.now(timezone.utc)
        else:
            raise AssertionError(f"unexpected SQL in tx: {s}")

    def fetchone(self):
        return self.result


@contextmanager
def fake_tx():
    yield FakeCursor()


def fake_query(sql, params=None, fetch="all"):
    s = " ".join(sql.split())
    if s.startswith("SELECT id FROM players WHERE token"):
        pid = PLAYERS.get(params[0])
        return {"id": pid} if pid else None
    if s.startswith("SELECT * FROM games WHERE id"):
        row = GAMES.get(params[0])
        return dict(row) if row else None
    raise AssertionError(f"unexpected SQL in query: {s}")


game_store.tx = fake_tx
game_store.query = fake_query


def make_game(human_seat=0):
    seats = [{"type": "ai", "model": "crusher1", "nickname": "Crusher"} for _ in range(3)]
    seats[human_seat] = {"type": "human", "player_id": "p-human", "nickname": "You"}
    game = gs.new_round_state(match_round=0)
    gs.advance_ai(game, seats)
    GAMES["g1"] = {
        "id": "g1", "status": "playing", "state": pimc_core.serialize(game),
        "seats": seats, "current_seat": game.current_player_idx, "match_round": 0,
        "total_scores": [0, 0, 0], "last_round_scores": None, "version": 0,
        "last_action_at": datetime.now(timezone.utc),
    }
    return human_seat


def test_full_match():
    random.seed(1)
    human_seat = make_game(human_seat=1)   # deliberately NOT seat 0

    # Bootstrap with a poll, then drive off apply_move responses (with one human
    # seat, every state that needs input is returned directly by apply_move).
    view = game_store.get_view("g1", "tok-human", since=-1)
    last_version = view["version"]
    rounds_seen = 0
    safety = 0
    while True:
        safety += 1
        assert safety < 5000, "match did not terminate"

        # redaction: never expose another seat's hand
        for i, p in enumerate(view["players"]):
            assert ("hand" in p) == (i == view["yourSeat"])
        assert view["yourSeat"] == human_seat
        assert view["version"] >= last_version
        last_version = view["version"]
        if view.get("roundScores"):
            rounds_seen = max(rounds_seen, view["matchRound"] + (1 if view["status"] == "done" else 0))

        if view["status"] == "done":
            print(f"match done: totals={view['totalScores']}, rounds observed={rounds_seen}")
            break
        assert view["yourTurn"], "1-human game: apply_move should always land on the human or done"

        action = random.choice(view["legalActions"])
        view = game_store.apply_move("g1", "tok-human", action)

    # A no-change poll must short-circuit.
    nochange = game_store.get_view("g1", "tok-human", since=last_version)
    assert nochange.get("changed") is False, "poll at current version should be a no-op"
    assert rounds_seen == gs.MATCH_ROUNDS, f"expected {gs.MATCH_ROUNDS} rounds, saw {rounds_seen}"
    print("OK: full match via game_store (move/advance/rounds/redaction).")


def test_rejections():
    make_game(human_seat=0)
    view = game_store.get_view("g1", "tok-human", since=-1)
    assert view["yourTurn"], "fresh round, human seat 0 leads bidding"
    legal = set(view["legalActions"])
    illegal = next(a for a in range(67) if a not in legal)
    try:
        game_store.apply_move("g1", "tok-human", illegal)
        raise AssertionError("illegal move was accepted")
    except game_store.MoveError as e:
        assert e.code == 400, e.code
    # bad token
    try:
        game_store.apply_move("g1", "nope", list(legal)[0])
        raise AssertionError("bad token accepted")
    except game_store.MoveError as e:
        assert e.code == 403, e.code
    print("OK: illegal action -> 400, bad token -> 403.")


def test_timeout_substitution():
    make_game(human_seat=0)
    # human's turn, but they 'disconnect' -> last_action_at far in the past
    GAMES["g1"]["last_action_at"] = datetime.now(timezone.utc) - timedelta(seconds=120)
    v_before = GAMES["g1"]["version"]
    view = game_store.get_view("g1", "tok-human", since=-1)
    assert GAMES["g1"]["version"] > v_before, "timeout should have advanced the game"
    print("OK: idle human seat auto-played on timeout.")


if __name__ == "__main__":
    test_full_match()
    test_rejections()
    test_timeout_substitution()
    print("\nALL game_store integration checks passed.")
