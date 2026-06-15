"""GET /api/game-state?gameId=<uuid>&token=<tok>&since=<version>
Ego-centric, redacted view for the caller's seat. Returns {changed:false,version}
when nothing changed since `version` (cheap polling).
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

    def do_GET(self):
        try:
            q = httputil.query_params(self)
            game_id = q.get("gameId", [None])[0]
            token = q.get("token", [None])[0]
            since = int(q.get("since", ["-1"])[0])
            if not game_id or not token:
                return httputil.send(self, 400, {"error": "gameId and token required"})
            view = game_store.get_view(game_id, token, since)
            httputil.send(self, 200, view)
        except game_store.MoveError as e:
            httputil.send(self, e.code, {"error": e.msg})
        except Exception as e:
            httputil.send(self, 500, {"error": f"{type(e).__name__}: {e}"})
