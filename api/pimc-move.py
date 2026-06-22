"""Vercel serverless function: POST a serialized game state, get the PIMC move.

  POST /api/pimc-move
  body: {"state": {...}, "seat": 1, "K": 10, "model": "crusher1"}
  resp: {"action": 27, "K": 10, "model": "crusher1"}

The browser keeps the authoritative game (webapp/js/game.js); it only calls this
for AI seats that use search. Sending the full state exposes nothing new -- the
client already holds every hand (it is a client-side PvE simulation), and PIMC
re-samples the opponents' cards anyway, so the server never "cheats".
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

# Vercel imports this module with /var/task on sys.path but NOT the function's
# own directory, so a bare `import pimc_core` (a sibling file) fails with
# ModuleNotFoundError. Put this file's directory on the path first.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pimc_core

ALLOWED_MODELS = {"crusher1", "minty1", "kingston2", "anker1", "rubiks1", "ginger1"}
MAX_K = 30


class handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):          # CORS preflight
        self._send(204, {})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")
            state = req["state"]
            seat = int(req["seat"])
            K = max(1, min(MAX_K, int(req.get("K", 10))))
            model = req.get("model", "crusher1")
            if model not in ALLOWED_MODELS:
                return self._send(400, {"error": f"unknown model '{model}'"})

            # "Smart bidding": when bidK is present/positive, the bidding phase
            # runs PIMC at that depth instead of greedy. Absent/<=0 = greedy bids.
            bid_k_raw = req.get("bidK")
            bid_k = max(1, min(MAX_K, int(bid_k_raw))) if bid_k_raw else None

            action = pimc_core.choose(state, seat, K, model, bid_k)
            self._send(200, {"action": action, "K": K, "model": model, "bidK": bid_k})
        except Exception as e:
            self._send(500, {"error": f"{type(e).__name__}: {e}"})
