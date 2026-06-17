// Arcanum — online multiplayer network client (PartyKit / WebSockets).
//
// Replaces the old fetch+poll Vercel/Neon client. Live games run on PartyKit
// (persistent rooms over WebSocket): the server is authoritative and pushes a
// redacted per-seat `view` after every move, so there is no polling. AI seats
// are resolved by the server via the Python PIMC sidecar; the server emits a
// `thinking` hint while it searches. See webapp/party/ for the backend.
//
// Identity: a persistent random playerId (localStorage `we_pid`) is the bearer
// for this player's seat in any room. Reconnecting with it resumes the seat.

const Online = (() => {
    // PartyKit host. Set window.PARTYKIT_HOST in index.html for production
    // (e.g. "arcanum.<user>.partykit.dev"); defaults to the local dev server.
    const HOST = (typeof window !== 'undefined' && window.PARTYKIT_HOST)
        || '127.0.0.1:1999';

    const PS = (typeof window !== 'undefined' && window.PartyKit && window.PartyKit.PartySocket);

    function playerId() {
        let id;
        try { id = localStorage.getItem('we_pid'); } catch { id = null; }
        if (!id) {
            id = (crypto.randomUUID ? crypto.randomUUID()
                : 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
            try { localStorage.setItem('we_pid', id); } catch { /* ignore */ }
        }
        return id;
    }

    function makeRoomCode() {
        const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let s = '';
        for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
        return s;
    }

    // ---- quick-match lobby socket ----
    // handlers: {onWaiting(count), onMatched(roomId), onError(msg)}
    function connectLobby(nick, handlers) {
        const pid = playerId();
        const socket = new PS({ host: HOST, party: 'lobby', room: 'main',
            query: { pid, nick } });
        socket.addEventListener('open', () => {
            socket.send(JSON.stringify({ type: 'queue', playerId: pid, nickname: nick }));
        });
        socket.addEventListener('message', (e) => {
            const m = safeParse(e.data);
            if (!m) return;
            if (m.type === 'waiting') handlers.onWaiting?.(m.count);
            else if (m.type === 'matched') handlers.onMatched?.(m.roomId);
            else if (m.type === 'error') handlers.onError?.(m.error);
        });
        socket.addEventListener('error', () => handlers.onError?.('connection error'));
        return {
            socket,
            fill: () => socket.send(JSON.stringify({ type: 'fill', playerId: pid, nickname: nick })),
            close: () => socket.close(),
        };
    }

    // ---- game-room socket (host rooms + matched quick-match games) ----
    // handlers: {onLobby(payload), onView(view), onThinking(t), onEnded(reason), onError(msg)}
    function connectGame(roomId, nick, handlers) {
        const pid = playerId();
        const socket = new PS({ host: HOST, party: 'game', room: roomId,
            query: { pid, nick } });
        socket.addEventListener('message', (e) => {
            const m = safeParse(e.data);
            if (!m) return;
            switch (m.type) {
                case 'lobby':    handlers.onLobby?.(m); break;
                case 'view':     handlers.onView?.(m.view); break;
                case 'thinking': handlers.onThinking?.(m); break;
                case 'warning':  handlers.onWarning?.(m.error); break;
                case 'ended':    handlers.onEnded?.(m.reason); break;
                case 'error':    handlers.onError?.(m.error); break;
            }
        });
        socket.addEventListener('error', () => handlers.onError?.('connection error'));
        return {
            socket,
            playerId: pid,
            configSeat: (seat, value) =>
                socket.send(JSON.stringify({ type: 'configSeat', seat, value })),
            start: () => socket.send(JSON.stringify({ type: 'start' })),
            move: (action, version) =>
                socket.send(JSON.stringify({ type: 'move', action, version })),
            undo: (color) => socket.send(JSON.stringify({ type: 'undo', color })),
            abandon: () => socket.send(JSON.stringify({ type: 'abandon' })),
            close: () => socket.close(),
        };
    }

    function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

    return { HOST, playerId, makeRoomCode, connectLobby, connectGame };
})();
