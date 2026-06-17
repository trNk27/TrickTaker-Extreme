"""Server-side PIMC for the web app, on onnxruntime (no torch).

Mirrors src/pimc_eval.py but swaps the PyTorch forward for an ONNX session, so
the Vercel function bundle stays small. The game engine (game_engine.py) is
reused verbatim -- it is pure numpy.

State contract (JSON, produced by webapp/js/pimc.js, consumed by deserialize):
    {
      "phase": "BIDDING"|"PLAYING"|"DISCARDING",
      "tricksPlayed": int,
      "startingPlayerOffset": int,
      "currentPlayerIdx": int,
      "poolSeals": [int x5],          # index = color 0..4
      "jokerPool": int,
      "roundHistoryMask": [0/1 x45],  # all cards played this round (incl. current trick)
      "currentTrick": [[playerIdx, cardId], ...],
      "pendingLeadColor": int|null,
      "pendingWinCard": int|null,     # card id, only set in DISCARDING
      "players": [                    # length 3, absolute seat order
        {"hand":[cardId...], "seals":[int x5], "initialSeals":[int x5],
         "jokerSeals":int, "blackSeals":int, "hasPassed":bool,
         "playedMask":[0/1 x45]},
        ...
      ]
    }
Request body adds: {"state": <above>, "seat": int, "K": int, "model": str}
"""
import copy
import os
import random

import numpy as np
import onnxruntime as ort

from game_engine import (ArcanumGame, Card, NUM_PLAYERS, TOTAL_CARDS,
                         CARDS_PER_COLOR, ACTION_SPACE_SIZE)

_SESSIONS = {}
_MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "models")


def get_session(model):
    """Cache one InferenceSession per model name (warm across invocations)."""
    if model not in _SESSIONS:
        path = os.path.join(_MODELS_DIR, f"{model}.onnx")
        so = ort.SessionOptions()
        so.intra_op_num_threads = int(os.environ.get("ORT_THREADS", "0")) or os.cpu_count() or 1
        _SESSIONS[model] = ort.InferenceSession(path, sess_options=so,
                                                providers=["CPUExecutionProvider"])
    return _SESSIONS[model]


def card_from_id(cid):
    return Card(cid // CARDS_PER_COLOR, cid % CARDS_PER_COLOR + 1)


# ---------------------------------------------------------------- serialization
def deserialize(st):
    g = ArcanumGame()
    g.phase = st["phase"]
    g.tricks_played = int(st["tricksPlayed"])
    g.starting_player_offset = int(st["startingPlayerOffset"])
    g.current_player_idx = int(st["currentPlayerIdx"])
    g.pool_seals = {c: int(st["poolSeals"][c]) for c in range(5)}
    g.joker_pool = int(st["jokerPool"])
    g.round_history_mask = np.array(st["roundHistoryMask"], dtype=int)
    g.current_trick = [(int(pi), card_from_id(int(cid))) for pi, cid in st["currentTrick"]]
    g.pending_lead_color = st.get("pendingLeadColor")
    pwc = st.get("pendingWinCard")
    g.pending_win_card = card_from_id(int(pwc)) if pwc is not None else None
    g.last_completed_trick = st.get("lastCompletedTrick")

    for i, pj in enumerate(st["players"]):
        p = g.players[i]
        p.hand = sorted([card_from_id(int(c)) for c in pj["hand"]], key=lambda c: c.id)
        p.seals = {c: int(pj["seals"][c]) for c in range(5)}
        p.initial_seals = {c: int(pj["initialSeals"][c]) for c in range(5)}
        p.joker_seals = int(pj["jokerSeals"])
        p.black_seals = int(pj["blackSeals"])
        p.has_passed_bidding = bool(pj["hasPassed"])
        p.played_cards_mask = np.array(pj["playedMask"], dtype=int)
    return g


def serialize(g):
    """Reference encoder (used by the local test; the browser mirrors this)."""
    return {
        "phase": g.phase,
        "tricksPlayed": int(g.tricks_played),
        "startingPlayerOffset": int(g.starting_player_offset),
        "currentPlayerIdx": int(g.current_player_idx),
        "poolSeals": [int(g.pool_seals[c]) for c in range(5)],
        "jokerPool": int(g.joker_pool),
        "roundHistoryMask": [int(x) for x in g.round_history_mask],
        "currentTrick": [[int(pi), int(card.id)] for pi, card in g.current_trick],
        "pendingLeadColor": g.pending_lead_color,
        "pendingWinCard": (int(g.pending_win_card.id)
                           if getattr(g, "pending_win_card", None) is not None else None),
        "lastCompletedTrick": getattr(g, "last_completed_trick", None),
        "players": [{
            "hand": [int(c.id) for c in p.hand],
            "seals": [int(p.seals[c]) for c in range(5)],
            "initialSeals": [int(p.initial_seals[c]) for c in range(5)],
            "jokerSeals": int(p.joker_seals),
            "blackSeals": int(p.black_seals),
            "hasPassed": bool(p.has_passed_bidding),
            "playedMask": [int(x) for x in p.played_cards_mask],
        } for p in g.players],
    }


# ------------------------------------------------------------------------ PIMC
def onnx_greedy(session, game, p):
    state = game.get_state(p).astype(np.float32)[None]
    logits = session.run(["logits"], {"state": state})[0][0]
    mask = game.get_legal_actions(p).astype(bool)
    masked = np.where(mask, logits, -np.inf)
    return int(np.argmax(masked))


def determinize(game, p):
    clone = copy.deepcopy(game)
    seen = set(np.flatnonzero(clone.round_history_mask).tolist())
    seen.update(c.id for c in clone.players[p].hand)
    unseen = [cid for cid in range(TOTAL_CARDS) if cid not in seen]
    random.shuffle(unseen)
    i = 0
    for opp in range(NUM_PLAYERS):
        if opp == p:
            continue
        n = len(clone.players[opp].hand)
        clone.players[opp].hand = sorted([card_from_id(cid) for cid in unseen[i:i + n]],
                                         key=lambda c: c.id)
        i += n
    return clone


def rollout(session, clone):
    done, info = False, None
    while not done:
        _, _, done, info = clone.step(onnx_greedy(session, clone, clone.current_player_idx))
    return info["scores"]


def relative_score(scores, p):
    """Margin of player p over the average of the other players.

    CURRENTLY NOT IN USE

    The game is won by ordinal standing (closest to 0 of three), not by absolute
    penalty, so the search optimises own-minus-mean rather than own score alone.
    This keeps p ahead and -- crucially -- punishes letting an opponent escape
    cheaply: it defends against a human who deliberately drops one seal to dump
    losing tricks (and black seals) onto the AI. For 3 players these margins sum
    to 0, so the objective stays zero-sum.
    """
    others = [s for i, s in enumerate(scores) if i != p]
    return scores[p] - sum(others) / len(others)


def pimc_action(session, game, p, K):
    mask = game.get_legal_actions(p)
    legal_plays = [a for a in range(16, 61) if mask[a]]
    if game.phase != "PLAYING":
        return onnx_greedy(session, game, p)
    if len(legal_plays) <= 1:
        return legal_plays[0]
    worlds = [determinize(game, p) for _ in range(K)]
    values = {a: 0.0 for a in legal_plays}
    for w in worlds:
        for a in legal_plays:
            c = copy.deepcopy(w)
            c.step(a)
            values[a] += rollout(session, c)[p]
    return max(legal_plays, key=lambda a: values[a])


def choose(state, seat, K, model):
    """Top-level entry: reconstruct, search, return action index."""
    game = deserialize(state)
    session = get_session(model)
    return pimc_action(session, game, int(seat), int(K))
