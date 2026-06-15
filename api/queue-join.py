"""POST /api/queue-join  {nickname}
Registers a player, enqueues them, and forms a 3-human game if three are waiting.
resp: {playerId, token, gameId|null}   (gameId set only if *this* player matched)
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import httputil
import matchmaking
from db import tx


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        httputil.send(self, 204, {})

    def do_POST(self):
        try:
            req = httputil.read_json(self)
            nickname = str(req.get("nickname", "")).strip() or "Player"
            with tx() as cur:
                player_id, token = matchmaking.create_player(cur, nickname)
                cur.execute(
                    "INSERT INTO queue (player_id, nickname) VALUES (%s, %s)",
                    (player_id, nickname))
                game_id = None
                waiting = matchmaking.grab_waiting(cur, 3)
                if len(waiting) >= 3:
                    gid = matchmaking.create_game(cur, waiting[:3], fill_ai=False)
                    if any(str(w["player_id"]) == str(player_id) for w in waiting[:3]):
                        game_id = gid
            httputil.send(self, 200, {
                "playerId": str(player_id),
                "token": token,
                "gameId": (str(game_id) if game_id else None),
            })
        except Exception as e:
            httputil.send(self, 500, {"error": f"{type(e).__name__}: {e}"})
