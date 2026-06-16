"""POST /api/game-abandon  {gameId, token}
Any player in the game may abandon it: the match is ended and deleted, so the
other players' next poll 404s and they return to the lobby. resp: {ok:true}
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import httputil
from db import tx


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        httputil.send(self, 204, {})

    def do_POST(self):
        try:
            req = httputil.read_json(self)
            game_id = req.get("gameId")
            token = req.get("token")
            if not game_id or not token:
                return httputil.send(self, 400, {"error": "gameId and token required"})
            with tx() as cur:
                cur.execute("SELECT seats FROM games WHERE id = %s FOR UPDATE", (game_id,))
                row = cur.fetchone()
                if not row:
                    return httputil.send(self, 200, {"ok": True})  # already gone
                cur.execute("SELECT id FROM players WHERE token = %s", (token,))
                prow = cur.fetchone()
                pid = prow["id"] if prow else None
                is_player = any(
                    s.get("type") == "human" and str(s.get("player_id")) == str(pid)
                    for s in row["seats"])
                if not is_player:
                    return httputil.send(self, 403, {"error": "not a player in this game"})
                cur.execute("DELETE FROM queue WHERE game_id = %s", (game_id,))
                cur.execute("DELETE FROM games WHERE id = %s", (game_id,))
            httputil.send(self, 200, {"ok": True})
        except Exception as e:
            httputil.send(self, 500, {"error": f"{type(e).__name__}: {e}"})
