"""GET /api/queue-status?playerId=<uuid>
Poll while waiting. resp: {status: 'waiting'|'matched', gameId|null}
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import httputil
import db


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        httputil.send(self, 204, {})

    def do_GET(self):
        try:
            pid = httputil.query_params(self).get("playerId", [None])[0]
            if not pid:
                return httputil.send(self, 400, {"error": "playerId required"})
            row = db.query(
                "SELECT status, game_id FROM queue WHERE player_id = %s "
                "ORDER BY joined_at DESC LIMIT 1", (pid,), fetch="one")
            if not row:
                return httputil.send(self, 404, {"error": "not in queue"})
            httputil.send(self, 200, {
                "status": row["status"],
                "gameId": (str(row["game_id"]) if row["game_id"] else None),
            })
        except Exception as e:
            httputil.send(self, 500, {"error": f"{type(e).__name__}: {e}"})
