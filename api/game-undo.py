"""POST /api/game-undo  {gameId, token, color}
Undo one of the caller's bidding takes/steals of `color` (returns it to the pool
or to the victim). Only valid during the caller's own bidding turn. Returns the
updated ego-centric view.
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import httputil
import game_store


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        httputil.send(self, 204, {})

    def do_POST(self):
        try:
            req = httputil.read_json(self)
            game_id = req.get("gameId")
            token = req.get("token")
            color = req.get("color")
            if not game_id or not token or color is None:
                return httputil.send(self, 400, {"error": "gameId, token, color required"})
            view = game_store.undo_seal(game_id, token, int(color))
            httputil.send(self, 200, view)
        except game_store.MoveError as e:
            httputil.send(self, e.code, {"error": e.msg})
        except Exception as e:
            httputil.send(self, 500, {"error": f"{type(e).__name__}: {e}"})
