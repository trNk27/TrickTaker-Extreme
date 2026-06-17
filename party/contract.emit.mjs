// Engine-parity / serialization-contract generator.
//
// Plays a full best-of-3 match through the SHARED JS engine (js/game.js, the
// same module the party uses), and at every step emits the pimc_core-contract
// serialization plus the JS engine's legal-action set for the seat to move.
// party/contract_check.py replays each state through the Python engine
// (api/game_engine.py) and asserts the legal actions match — guarding the two
// engines + the serialize/deserialize contract at the sidecar boundary.
//
// Build+run via esbuild (see party/run_contract.sh). Writes JSONL to stdout.
import {
  serializeGame,
  newRoundState,
  legalActions,
} from "./engine.ts";

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

// Deterministic-ish PRNG so the emitted trace is reproducible across runs.
let seed = 12345;
function rng() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

const lines = [];
for (let round = 0; round < 3; round++) {
  const g = newRoundState(round);
  let steps = 0;
  while (true) {
    const seat = g.currentPlayerIdx;
    const la = legalActions(g, seat);
    lines.push(JSON.stringify({ round, step: steps, seat, state: serializeGame(g), legal: la }));
    const a = pick(la, rng);
    const res = g.step(a);
    steps++;
    if (res.done) break;
    if (steps > 5000) throw new Error("runaway");
  }
}
process.stdout.write(lines.join("\n") + "\n");
