"""Engine-parity / contract checker (Python side).

Reads the JSONL trace emitted by party/contract.emit.mjs (one record per game
step: the pimc_core-contract state + the JS engine's legal actions), replays
each state through the Python engine via pimc_core.deserialize +
get_legal_actions, and asserts the legal-action sets match exactly.

This guards two things at once:
  1. js/game.js (party authoritative engine) and api/game_engine.py (sidecar
     engine) agree on the rules.
  2. The serialize/deserialize contract round-trips losslessly.

Run:  cd webapp && python party/contract_check.py < trace.jsonl
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api"))

import pimc_core  # noqa: E402


def legal_set(state, seat):
    g = pimc_core.deserialize(state)
    mask = g.get_legal_actions(seat)
    return [int(a) for a in np.flatnonzero(mask)]


def main():
    n = 0
    mismatches = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        py = legal_set(rec["state"], rec["seat"])
        js = sorted(int(a) for a in rec["legal"])
        if py != js:
            mismatches += 1
            if mismatches <= 10:
                print(f"MISMATCH round={rec['round']} step={rec['step']} "
                      f"seat={rec['seat']}\n  js={js}\n  py={py}")
        n += 1
    print(f"checked {n} states, {mismatches} mismatches")
    sys.exit(1 if mismatches else 0)


if __name__ == "__main__":
    main()
