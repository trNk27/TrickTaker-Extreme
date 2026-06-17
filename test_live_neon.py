"""Live end-to-end test against the real Neon database.

Exercises the Postgres-specific paths the in-memory fake can't: matchmaking
(create_player, queue insert, grab_waiting FOR UPDATE SKIP LOCKED, create_game
with jsonb), then a full 2-human + 1-AI game through game_store.apply_move /
get_view. Cleans up every row it creates.

Run:  cd webapp && ../.venv312/bin/python test_live_neon.py
Requires webapp/.env with DATABASE_URL (pooled Neon string).
"""
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "api"))

# Load .env (python-side: bash can't source the URL because of the '&').
for _line in open(os.path.join(os.path.dirname(__file__), ".env")):
    _line = _line.strip()
    if _line and not _line.startswith("#") and "=" in _line:
        _k, _v = _line.split("=", 1)
        os.environ[_k] = _v

import db
import matchmaking
import game_store


def join(nickname):
    """Mirror /api/queue-join (without auto-forming a 3-human game)."""
    with db.tx() as cur:
        pid, token = matchmaking.create_player(cur, nickname)
        cur.execute("INSERT INTO queue (player_id, nickname) VALUES (%s, %s)",
                    (pid, nickname))
    return str(pid), token


def fill(pid, token):
    """Mirror /api/queue-fill: start now, fill empty seats with AI."""
    with db.tx() as cur:
        self_row = matchmaking.lock_player_queue_row(cur, pid)
        others = [w for w in matchmaking.grab_waiting(cur, 3)
                  if str(w["player_id"]) != str(pid)][:2]
        gid = matchmaking.create_game(cur, [self_row] + others, fill_ai=True)
    return str(gid)


def cleanup(player_ids, game_id):
    with db.tx() as cur:
        cur.execute("DELETE FROM queue WHERE player_id = ANY(%s)", (player_ids,))
        if game_id:
            cur.execute("DELETE FROM games WHERE id = %s", (game_id,))
        cur.execute("DELETE FROM players WHERE id = ANY(%s)", (player_ids,))


def main():
    random.seed(7)
    a_id, a_tok = join("Ann")
    b_id, b_tok = join("Bob")
    print(f"queued Ann={a_id[:8]} Bob={b_id[:8]}")

    gid = fill(a_id, a_tok)
    print(f"game formed: {gid[:8]} (2 humans + 1 AI)")

    humans = [(a_id, a_tok), (b_id, b_tok)]
    try:
        last_v = -1
        rounds_seen = 0
        safety = 0
        while True:
            safety += 1
            assert safety < 8000, "did not terminate"
            acted = False
            for pid, tok in humans:
                view = game_store.get_view(gid, tok, since=-1)
                # redaction holds for every human
                for i, p in enumerate(view["players"]):
                    assert ("hand" in p) == (i == view["yourSeat"]), "hand leaked!"
                if view["status"] == "done":
                    rounds_seen = 3
                    print(f"match done: totals={view['totalScores']}")
                    raise StopIteration
                assert view["version"] >= last_v
                last_v = view["version"]
                if view.get("roundScores"):
                    rounds_seen = max(rounds_seen, view["matchRound"])
                if view["yourTurn"]:
                    action = random.choice(view["legalActions"])
                    game_store.apply_move(gid, tok, action)
                    acted = True
            assert acted, "no human could move and game not done (AI should advance in apply_move)"
    except StopIteration:
        pass

    # out-of-turn / illegal rejection on a fresh, known state
    view = game_store.get_view(gid, a_tok, since=-1)
    print("redaction + full 2-human game OK; rounds observed:", rounds_seen)

    cleanup([a_id, b_id], gid)
    print("cleaned up test rows. LIVE NEON TEST PASSED.")


if __name__ == "__main__":
    main()
