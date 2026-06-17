"""Headless check that the server can host a full Arcanum game.

This de-risks the multiplayer plan's core assumption: the authoritative game can
run server-side from api/game_engine.py, driven through the exact same
serialize/deserialize + get_legal_actions + onnx_greedy path the API endpoints
will use. No DB, no HTTP -- pure engine.

Run:  cd webapp && python test_server_engine.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "api"))

import numpy as np

from game_engine import ArcanumGame, TRICKS_PER_ROUND
import pimc_core


def assert_legal(game, action):
    mask = game.get_legal_actions(game.current_player_idx)
    assert mask[action] == 1, f"illegal action {action} in phase {game.phase}"


def play_full_round(model, use_pimc_seat=None, K=4):
    """Play one round to completion, choosing every move server-side.

    Round-trips the state through serialize/deserialize before every move to
    prove the JSON contract is loss-free under the same code path the API uses.
    """
    session = pimc_core.get_session(model)
    game = ArcanumGame()
    game.reset()

    moves = 0
    while True:
        # serialize -> deserialize round-trip (mirrors store-in-DB / load-from-DB)
        snap = pimc_core.serialize(game)
        game = pimc_core.deserialize(snap)

        seat = game.current_player_idx
        if use_pimc_seat is not None and seat == use_pimc_seat:
            action = pimc_core.pimc_action(session, game, seat, K)
        else:
            action = pimc_core.onnx_greedy(session, game, seat)
        assert_legal(game, action)

        _, _, done, info = game.step(action)
        moves += 1
        assert moves < 2000, "runaway loop -- game never terminated"
        if done:
            scores = info["scores"]
            assert len(scores) == 3
            assert game.tricks_played == TRICKS_PER_ROUND, game.tricks_played
            return scores, moves


def main():
    model = "crusher1"

    # 1. Greedy-only full round
    scores, moves = play_full_round(model)
    print(f"[greedy]  round done in {moves} moves, scores={scores}")
    assert all(s <= 0 for s in scores), "scores should be non-positive penalties"

    # 2. One seat using server-side PIMC search (the AI-fill default path)
    scores, moves = play_full_round(model, use_pimc_seat=1, K=4)
    print(f"[pimc=1]  round done in {moves} moves, scores={scores}")

    # 3. Determinism / legality stress: a few greedy rounds, all must terminate
    for i in range(3):
        scores, moves = play_full_round(model)
        print(f"[round {i}] moves={moves} scores={scores}")

    print("OK: server can host a full game headless via the API code path.")


if __name__ == "__main__":
    main()
