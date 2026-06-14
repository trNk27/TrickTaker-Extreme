// PIMC client: serialize the local game state and ask the server for a search move.
// Pairs with webapp/api/pimc-move.py + pimc_core.py (deserialize expects this shape).
// The browser stays the authoritative engine (game.js); this only fetches AI moves
// for seats that use server-side search.

const COLORS5 = [0, 1, 2, 3, 4];

function serializeGameState(game) {
    return {
        phase: game.phase,
        tricksPlayed: game.tricksPlayed,
        startingPlayerOffset: game.startingPlayerOffset,
        currentPlayerIdx: game.currentPlayerIdx,
        poolSeals: COLORS5.map(c => game.poolSeals[c]),
        jokerPool: game.jokerPool,
        roundHistoryMask: Array.from(game.roundHistoryMask),
        currentTrick: game.currentTrick.map(t => [t.playerIdx, t.card.id]),
        pendingLeadColor: game.pendingLeadColor,
        pendingWinCard: game.pendingWinCard ? game.pendingWinCard.id : null,
        players: game.players.map(p => ({
            hand: p.hand.map(c => c.id),
            seals: COLORS5.map(c => p.seals[c]),
            initialSeals: COLORS5.map(c => p.initialSeals[c]),
            jokerSeals: p.jokerSeals,
            blackSeals: p.blackSeals,
            hasPassed: p.hasPassedBidding,
            playedMask: Array.from(p.playedCardsMask),
        })),
    };
}

// Returns an action index (0..66). Throws on network/server error so the caller
// can fall back to a local greedy move.
async function fetchPimcMove(game, seat, K = 10, model = 'crusher1', endpoint = '/api/pimc-move') {
    const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: serializeGameState(game), seat, K, model }),
    });
    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`pimc-move HTTP ${resp.status} ${detail}`);
    }
    const data = await resp.json();
    if (typeof data.action !== 'number') throw new Error('pimc-move: no action in response');
    return data.action;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { serializeGameState, fetchPimcMove };
}
