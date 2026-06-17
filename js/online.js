// Arcanum — online multiplayer network client.
// Thin fetch wrappers around the Vercel serverless endpoints. The server is
// authoritative; the browser only submits the local player's actions and polls
// for the redacted ego-centric view. See webapp/api/ for the backend.

const OnlineNet = (() => {
    const POLL_INTERVAL_MS = 1000;   // turn-based; 1s balances snappiness vs Neon compute-hours
    const API = '';                  // same origin (Vercel)

    async function post(path, body) {
        const resp = await fetch(`${API}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `${path} HTTP ${resp.status}`);
        return data;
    }

    async function get(path) {
        const resp = await fetch(`${API}${path}`);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `${path} HTTP ${resp.status}`);
        return data;
    }

    return {
        POLL_INTERVAL_MS,
        // -> {playerId, token, gameId|null}
        joinQueue: (nickname) => post('/api/queue-join', { nickname }),
        // -> {status:'waiting'|'matched', gameId|null}
        queueStatus: (playerId) => get(`/api/queue-status?playerId=${encodeURIComponent(playerId)}`),
        // -> {gameId}
        fillWithAI: (playerId, token) => post('/api/queue-fill', { playerId, token }),
        // -> view | {changed:false, version}
        getState: (gameId, token, since) =>
            get(`/api/game-state?gameId=${encodeURIComponent(gameId)}` +
                `&token=${encodeURIComponent(token)}&since=${since}`),
        // -> updated view
        move: (gameId, token, action) => post('/api/game-move', { gameId, token, action }),
        // -> {ok:true}; ends + deletes the match for everyone
        abandon: (gameId, token) => post('/api/game-abandon', { gameId, token }),
        // -> updated view; undo one bidding take/steal of `color`
        undo: (gameId, token, color) => post('/api/game-undo', { gameId, token, color }),
    };
})();
