"""Local PIMC sidecar for `partykit dev` end-to-end testing.

Serves the same contract as the deployed api/pimc-move.py (POST {state, seat, K,
model} -> {action}) on http://127.0.0.1:3000/api/pimc-move, backed by
api/pimc_core.choose. Not used in production (Vercel runs pimc-move.py directly).

Run:  cd webapp && python party/_localsidecar.py
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api"))
import pimc_core  # noqa: E402

ALLOWED = {"crusher1", "minty1", "kingston2"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # quiet

    def do_OPTIONS(self):  # CORS preflight (browser single-player calls this cross-origin)
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            model = req.get("model", "crusher1")
            if model not in ALLOWED:
                return self._send(400, {"error": f"unknown model '{model}'"})
            K = max(1, min(30, int(req.get("K", 10))))
            action = pimc_core.choose(req["state"], int(req["seat"]), K, model)
            self._send(200, {"action": action, "K": K, "model": model})
        except Exception as e:
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(os.environ.get("SIDECAR_PORT", "3000"))
    print(f"PIMC sidecar on http://127.0.0.1:{port}/api/pimc-move", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
