"""POST /api/game-move  {gameId, token, action}
Validates it's the caller's turn and the action is legal, applies it, then runs
AI seats forward to the next human decision. Returns the updated ego-centric view.
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
            action = req.get("action")
            if not game_id or not token or action is None:
                return httputil.send(self, 400, {"error": "gameId, token, action required"})
            view = game_store.apply_move(game_id, token, int(action))
            httputil.send(self, 200, view)
        except game_store.MoveError as e:
            httputil.send(self, e.code, {"error": e.msg})
        except Exception as e:
            httputil.send(self, 500, {"error": f"{type(e).__name__}: {e}"})
