"""Matchmaking: form games from the queue. Used by queue-join / queue-fill.

All functions take an open transaction cursor (db.tx()) so seat assignment and
queue updates commit atomically. Concurrent invocations are isolated with
SELECT ... FOR UPDATE SKIP LOCKED on the waiting rows.
"""
import json
import random
import secrets

import game_session

AI_FILL = {"type": "ai", "model": "crusher1", "pimc": 10, "nickname": "Crusher"}


def create_player(cur, nickname):
    token = secrets.token_urlsafe(16)
    cur.execute(
        "INSERT INTO players (nickname, token) VALUES (%s, %s) RETURNING id",
        (nickname[:32] or "Player", token))
    return cur.fetchone()["id"], token


def grab_waiting(cur, limit=3):
    """Lock up to `limit` waiting queue rows (oldest first), skipping locked."""
    cur.execute(
        "SELECT id, player_id, nickname FROM queue "
        "WHERE status = 'waiting' ORDER BY joined_at "
        "FOR UPDATE SKIP LOCKED LIMIT %s", (limit,))
    return cur.fetchall()


def create_game(cur, humans, fill_ai):
    """Build a game from `humans` (list of {id|player_id, nickname, queue_id?}).

    Seats are assigned at random. Remaining seats are AI iff fill_ai. Marks the
    humans' queue rows matched. Returns game_id.
    """
    n = len(humans)
    if n == 0 or n > 3:
        raise ValueError(f"bad human count {n}")
    if n < 3 and not fill_ai:
        raise ValueError("not enough humans and fill_ai is False")

    order = [0, 1, 2]
    random.shuffle(order)
    human_seats = order[:n]

    seats = [dict(AI_FILL) for _ in range(3)]
    for h, s in zip(humans, human_seats):
        seats[s] = {"type": "human", "player_id": str(h["player_id"]),
                    "nickname": h["nickname"]}

    game = game_session.new_round_state(match_round=0)
    # Move past any leading AI seats so current_seat lands on a human (or stays
    # put if a human leads). A fresh round never ends here.
    game_session.advance_ai(game, seats)

    import pimc_core
    cur.execute(
        "INSERT INTO games (state, seats, current_seat, status, match_round, "
        "total_scores, version) VALUES (%s, %s, %s, 'playing', 0, '[0,0,0]', 0) "
        "RETURNING id",
        (json.dumps(pimc_core.serialize(game)), json.dumps(seats),
         game.current_player_idx))
    game_id = cur.fetchone()["id"]

    for h, s in zip(humans, human_seats):
        cur.execute(
            "UPDATE queue SET status = 'matched', game_id = %s, seat = %s "
            "WHERE id = %s", (game_id, s, h["id"]))
    return game_id


def lock_player_queue_row(cur, player_id):
    cur.execute(
        "SELECT id, player_id, nickname, status, game_id FROM queue "
        "WHERE player_id = %s ORDER BY joined_at DESC LIMIT 1 FOR UPDATE",
        (player_id,))
    return cur.fetchone()
