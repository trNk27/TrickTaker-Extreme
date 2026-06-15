"""POST /api/queue-fill  {playerId, token}
Player-initiated: start now with whoever is waiting, fill empty seats with
Crusher1 PIMC K=10. resp: {gameId}
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
            pid = req.get("playerId")
            token = req.get("token")
            if not pid or not token:
                return httputil.send(self, 400, {"error": "playerId and token required"})
            with tx() as cur:
                cur.execute("SELECT token FROM players WHERE id = %s", (pid,))
                prow = cur.fetchone()
                if not prow or prow["token"] != token:
                    return httputil.send(self, 403, {"error": "bad token"})

                self_row = matchmaking.lock_player_queue_row(cur, pid)
                if not self_row:
                    return httputil.send(self, 404, {"error": "not in queue"})
                if self_row["status"] == "matched" and self_row["game_id"]:
                    return httputil.send(self, 200, {"gameId": str(self_row["game_id"])})

                others = [w for w in matchmaking.grab_waiting(cur, 3)
                          if str(w["player_id"]) != str(pid)][:2]
                humans = [self_row] + others
                game_id = matchmaking.create_game(cur, humans, fill_ai=True)
            httputil.send(self, 200, {"gameId": str(game_id)})
        except Exception as e:
            httputil.send(self, 500, {"error": f"{type(e).__name__}: {e}"})
