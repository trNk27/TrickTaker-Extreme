"""Headless check of the orchestration layer (game_session) with no DB/HTTP.

Drives a full best-of-3 match: seat 0 is the "human" (we pick its moves with
greedy), seats 1-2 are AI. Mirrors the round/match transition logic in
game_store._progress so we exercise advance_ai + apply_round_result + the
redacted view builder.

Run:  cd webapp && python test_server_session.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "api"))

import pimc_core
import game_session as gs

HUMAN = 0
SEATS = [
    {"type": "human", "player_id": "p0", "nickname": "You"},
    {"type": "ai", "model": "crusher1", "pimc": 4, "nickname": "Crusher"},
    {"type": "ai", "model": "crusher1", "nickname": "Greedy"},
]


def human_move(session, game, seat):
    return pimc_core.onnx_greedy(session, game, seat)


def main():
    session = pimc_core.get_session("crusher1")
    game = gs.new_round_state(match_round=0)
    gs.advance_ai(game, SEATS)              # reach first human decision

    total = [0, 0, 0]
    match_round = 0
    status = "playing"
    moves = 0

    while status == "playing":
        assert game.current_player_idx == HUMAN, "control should be at the human"

        # Build + check the redacted view the human would receive.
        view = gs.build_view(game, SEATS, total, match_round, status, moves, HUMAN)
        assert view["yourTurn"] is True
        assert view["legalActions"], "human should have legal actions on their turn"
        assert "hand" in view["players"][HUMAN]
        assert "hand" not in view["players"][1] and "hand" not in view["players"][2], \
            "opponent hands must NOT be exposed"

        action = human_move(session, game, HUMAN)
        assert game.get_legal_actions(HUMAN)[action] == 1
        _, _, done, info = game.step(action)
        moves += 1

        if not done:
            done, scores = gs.advance_ai(game, SEATS)
        else:
            scores = info["scores"]

        if done:
            total, next_round, match_done = gs.apply_round_result(scores, total, match_round)
            print(f"round {match_round} scores={scores} totals={total}")
            if match_done:
                status = "done"
            else:
                match_round = next_round
                game = gs.new_round_state(match_round)
                gs.advance_ai(game, SEATS)

        assert moves < 5000

    assert match_round == gs.MATCH_ROUNDS - 1
    final = gs.build_view(game, SEATS, total, match_round, "done", moves, HUMAN)
    assert final["status"] == "done" and final["yourTurn"] is False
    print(f"match done after {moves} human moves, total scores={total}")
    print("OK: orchestration + redaction validated headless.")


if __name__ == "__main__":
    main()
