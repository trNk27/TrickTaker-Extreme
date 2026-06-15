// Wizard Extreme UI Controller — Arcane direction
// Renders into the new index.html markup. Game logic untouched.

class GameUI {
    constructor() {
        this.game = new WizardExtremeGame();
        this.ai = [new WizardAI(), new WizardAI()];
        this.humanPlayer = 0;
        this.gameStarted = false;

        this.matchRound = 0;
        this.totalScores = [0, 0, 0];
        this.roundScores = []; // array of [s0,s1,s2] per completed round
        this.ai1Difficulty = 'casio2';
        this.ai2Difficulty = 'crusher1';

        // Render methods are relative to humanPlayer + playerLabels so the same
        // code serves local play (you = seat 0) and online play (you = any seat).
        this.playerLabels = ['You', 'AI 1', 'AI 2'];

        // Online multiplayer state (mode === 'online'); unused in local play.
        this.mode = 'local';
        this.online = { playerId: null, token: null, gameId: null,
                        version: -1, polling: false, lastMatchRound: 0 };

        // Re-entrancy lock. A match is exactly 3 full rounds (one per seat). The
        // trick-completing play defers game.step() behind a 2s reveal; a second
        // input during that window would spawn a parallel turn loop and fire
        // handleRoundOver twice, jumping matchRound past a round and ending the
        // match after only 2 rounds. Set while a move is resolving, cleared when
        // control returns to the human.
        this.busy = false;

        // Single handle for the next scheduled step. The whole game is one turn
        // loop; we never want two pending timers. (Bidding seal-takes keep the
        // human's turn but used to each schedule a processNextTurn — taking
        // several within 500ms stacked timers that later launched parallel loops,
        // which stepped a play action into the DISCARDING phase and produced a
        // spurious black seal.) Every schedule clears the previous one.
        this.nextTimer = null;
    }

    // Schedule the single next step, replacing any pending one (enforces one loop).
    scheduleNext(fn, delay) {
        clearTimeout(this.nextTimer);
        this.nextTimer = setTimeout(fn, delay);
    }

    async init() {
        this.setupEventListeners();
        this.showDifficultySelect();
        this.tryResumeOnline();
    }

    // Rejoin an in-progress online game after a refresh; falls back to the lobby
    // if the stored game is gone or finished.
    tryResumeOnline() {
        let saved;
        try { saved = JSON.parse(localStorage.getItem('we_online') || 'null'); } catch { saved = null; }
        if (!saved || !saved.gameId || !saved.playerId || !saved.token) return;
        this.mode = 'online';
        this.online.playerId = saved.playerId;
        this.online.token = saved.token;
        this.enterOnlineGame(saved.gameId);
    }

    setupEventListeners() {
        document.getElementById('start-game-btn')?.addEventListener('click', () => this.startMatch());

        // Online multiplayer
        document.getElementById('play-online-btn')?.addEventListener('click', () => this.startOnline());
        document.getElementById('fill-ai-btn')?.addEventListener('click', () => this.fillWithAI());
        document.getElementById('online-cancel-btn')?.addEventListener('click', () => {
            localStorage.removeItem('we_online');
            this.backToOnlineLobby();
        });

        document.querySelectorAll('.bid-btn').forEach(btn => {
            btn.addEventListener('click', () => this.handleBid(parseInt(btn.dataset.action)));
        });
        document.querySelectorAll('.steal-btn').forEach(btn => {
            btn.addEventListener('click', () => this.handleBid(parseInt(btn.dataset.action)));
        });
        document.querySelectorAll('.discard-btn').forEach(btn => {
            btn.addEventListener('click', () => this.handleDiscard(parseInt(btn.dataset.action)));
        });

        // Rules modal
        const rulesBtn = document.getElementById('rules-btn');
        const lobbyRulesBtn = document.getElementById('lobby-rules-btn');
        const rulesModal = document.getElementById('rules-modal');
        const rulesClose = document.getElementById('rules-close');
        const openRules = () => rulesModal.classList.remove('hidden');
        const closeRules = () => rulesModal.classList.add('hidden');
        rulesBtn?.addEventListener('click', openRules);
        lobbyRulesBtn?.addEventListener('click', openRules);
        rulesClose?.addEventListener('click', closeRules);
        rulesModal?.addEventListener('click', (e) => {
            if (e.target === rulesModal) closeRules();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !rulesModal.classList.contains('hidden')) closeRules();
        });
    }

    // 'crusher1-pimc10' → { model: 'crusher1', pimc: 10 }
    // 'crusher1'        → { model: 'crusher1', pimc: null }
    parseDifficulty(value) {
        const m = value.match(/^(.+)-pimc(\d+)$/);
        return m ? { model: m[1], pimc: parseInt(m[2]) } : { model: value, pimc: null };
    }

    displayName(difficulty) {
        const { model, pimc } = this.parseDifficulty(difficulty);
        const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
        return pimc !== null ? `${cap(model)} · PIMC K=${pimc}` : cap(model);
    }

    async startMatch() {
        if (this.busy) return; // ignore repeat taps during model load
        this.busy = true;
        this.ai1Difficulty = document.getElementById('ai1-difficulty').value;
        this.ai2Difficulty = document.getElementById('ai2-difficulty').value;

        document.getElementById('difficulty-select').classList.add('hidden');
        document.getElementById('loading').classList.remove('hidden');

        await this.ai[0].loadModel(this.parseDifficulty(this.ai1Difficulty).model);
        await this.ai[1].loadModel(this.parseDifficulty(this.ai2Difficulty).model);

        this.matchRound = 0;
        this.totalScores = [0, 0, 0];
        this.roundScores = [];

        document.getElementById('loading').classList.add('hidden');
        this.startRound();
    }

    startRound() {
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('game-area').classList.remove('hidden');
        document.getElementById('game-over').classList.add('hidden');

        // Set opponent labels
        document.getElementById('opponent-1-name').textContent = 'AI 1';
        document.getElementById('opponent-1-meta').textContent = this.displayName(this.ai1Difficulty);
        document.getElementById('opponent-2-name').textContent = 'AI 2';
        document.getElementById('opponent-2-meta').textContent = this.displayName(this.ai2Difficulty);

        this.game.startingPlayerOffset = this.matchRound;
        this.game.reset();
        this.gameStarted = true;
        this.busy = false; // fresh round: a single turn loop starts below
        clearTimeout(this.nextTimer);

        this.render();
        this.processNextTurn();
    }

    showDifficultySelect() {
        document.getElementById('difficulty-select').classList.remove('hidden');
        document.getElementById('game-area').classList.add('hidden');
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('game-over').classList.add('hidden');
        this.gameStarted = false;
        this.busy = false;
        clearTimeout(this.nextTimer);
    }

    render() {
        this.renderHand();
        this.renderOpponents();
        this.renderTrick();
        this.renderBidding();
        this.renderSeals();
        this.renderDiscard();
        this.renderStatus();
        this.renderSidebar();
    }

    // ---------- Cards ----------
    createCardElement(card) {
        // Creature glyphs by rank — abstract symbols, no emoji
        // 1..9 in escalating power
        const glyphs = ['◦', '∙', '◆', '✦', '✧', '☽', '☼', '♕', '✶'];
        const ranks = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
        const glyph = glyphs[card.value - 1];
        const rank = ranks[card.value - 1];
        const suitGlyph = ['♦', '◈', '◇', '♢', '◉'][card.color]; // abstract suit marks

        const el = document.createElement('div');
        const trumpClass = card.color === 0 ? ' trump' : '';
        el.className = `card card-color-${card.color}${trumpClass}`;

        const tl = document.createElement('div');
        tl.className = 'card-corner tl';
        tl.innerHTML = `${rank}<span class="card-corner-suit">${suitGlyph}</span>`;

        const center = document.createElement('div');
        center.className = 'card-center';
        const creature = document.createElement('div');
        creature.className = 'card-creature';
        creature.style.fontSize = (16 + card.value * 1.6) + 'px';
        creature.textContent = glyph;
        center.appendChild(creature);

        const br = document.createElement('div');
        br.className = 'card-corner br';
        br.innerHTML = `${rank}<span class="card-corner-suit">${suitGlyph}</span>`;

        el.appendChild(tl);
        el.appendChild(center);
        el.appendChild(br);
        return el;
    }

    renderHand() {
        const container = document.getElementById('player-hand');
        container.innerHTML = '';

        const player = this.game.players[this.humanPlayer];
        const legalMask = this.game.getLegalActions(this.humanPlayer);

        for (const card of player.hand) {
            const cardEl = this.createCardElement(card);
            const isPlayable = this.game.phase === 'PLAYING' &&
                this.game.currentPlayerIdx === this.humanPlayer &&
                legalMask[card.id + 16];

            if (isPlayable) {
                cardEl.classList.add('playable');
                cardEl.addEventListener('click', () => this.handleCardClick(card));
            }
            container.appendChild(cardEl);
        }
    }

    renderOpponents() {
        for (let slot = 1; slot <= 2; slot++) {
            const absSeat = (this.humanPlayer + slot) % 3; // relative to you
            const container = document.getElementById(`opponent-${slot}-hand`);
            container.innerHTML = '';

            const player = this.game.players[absSeat];
            const count = player.hand.length;
            const angleStep = 4;
            const startAngle = -((count - 1) * angleStep) / 2;

            for (let i = 0; i < count; i++) {
                const cardBack = document.createElement('div');
                cardBack.className = 'card-back';
                const angle = startAngle + (i * angleStep);
                const translateY = Math.abs(angle) * 0.5;
                cardBack.style.transform = `rotate(${angle}deg) translateY(${translateY}px)`;
                container.appendChild(cardBack);
            }
        }
    }

    renderTrick() {
        const container = document.getElementById('trick-area');
        container.innerHTML = '<div class="trick-glow"></div>';

        for (const { playerIdx, card } of this.game.currentTrick) {
            const relPos = (playerIdx - this.humanPlayer + 3) % 3; // you at the bottom
            const wrapper = document.createElement('div');
            wrapper.className = `trick-card trick-pos-${relPos}`;
            wrapper.appendChild(this.createCardElement(card));
            container.appendChild(wrapper);
        }
    }

    renderBidding() {
        const bidContainer = document.getElementById('bid-buttons');
        const stealContainer = document.getElementById('steal-buttons');

        const isHumanBidding = this.game.phase === 'BIDDING' &&
            this.game.currentPlayerIdx === this.humanPlayer &&
            !this.game.players[this.humanPlayer].hasPassedBidding;

        if (isHumanBidding) {
            const legalMask = this.game.getLegalActions(this.humanPlayer);

            // Show bid panel if any take/pass action is legal
            const anyBidLegal = legalMask.slice(0, 6).some(x => x);
            // Show steal panel if any steal action is legal
            const anyStealLegal = legalMask.slice(6, 16).some(x => x);

            if (anyBidLegal) {
                bidContainer.classList.remove('hidden');
                document.querySelectorAll('.bid-btn').forEach(btn => {
                    const action = parseInt(btn.dataset.action);
                    btn.disabled = !legalMask[action];
                });
            } else {
                bidContainer.classList.add('hidden');
            }

            if (anyStealLegal) {
                stealContainer.classList.remove('hidden');
                document.querySelectorAll('.steal-btn').forEach(btn => {
                    const action = parseInt(btn.dataset.action);
                    btn.disabled = !legalMask[action];
                });
            } else {
                stealContainer.classList.add('hidden');
            }
        } else {
            bidContainer.classList.add('hidden');
            stealContainer.classList.add('hidden');
        }
    }

    renderDiscard() {
        const container = document.getElementById('discard-buttons');
        const isHumanDiscarding = this.game.phase === 'DISCARDING' &&
            this.game.currentPlayerIdx === this.humanPlayer;

        if (isHumanDiscarding) {
            container.classList.remove('hidden');
            const legalMask = this.game.getLegalActions(this.humanPlayer);
            document.querySelectorAll('.discard-btn').forEach(btn => {
                const action = parseInt(btn.dataset.action);
                btn.disabled = !legalMask[action];
            });
        } else {
            container.classList.add('hidden');
        }
    }

    renderSeals() {
        // Pool seals — only during bidding
        const poolContainer = document.getElementById('pool-seals');
        if (this.game.phase === 'BIDDING') {
            poolContainer.classList.remove('hidden');
            poolContainer.innerHTML = '<div class="pool-label">Pool</div>';

            const sealsContainer = document.createElement('div');
            sealsContainer.className = 'seals-container';

            for (let c = 0; c < 5; c++) {
                const count = this.game.poolSeals[c];
                if (count > 0) {
                    const group = document.createElement('div');
                    group.className = 'seal-group';
                    for (let i = 0; i < count; i++) {
                        const seal = document.createElement('div');
                        seal.className = `seal seal-color-${c}`;
                        group.appendChild(seal);
                    }
                    sealsContainer.appendChild(group);
                }
            }
            poolContainer.appendChild(sealsContainer);
        } else {
            poolContainer.classList.add('hidden');
        }

        // Player + opponent seals (relative to your seat)
        for (let pIdx = 0; pIdx < 3; pIdx++) {
            const player = this.game.players[pIdx];
            const slot = (pIdx - this.humanPlayer + 3) % 3; // 0 = you, 1/2 = opponents
            const containerId = slot === 0 ? 'player-seals' : `opponent-${slot}-seals`;
            const container = document.getElementById(containerId);
            if (!container) continue;
            container.innerHTML = '';

            for (let c = 0; c < 5; c++) {
                const count = player.seals[c];
                if (count > 0) {
                    const group = document.createElement('div');
                    group.className = 'seal-group';
                    for (let i = 0; i < count; i++) {
                        const seal = document.createElement('div');
                        seal.className = `seal seal-color-${c}`;
                        group.appendChild(seal);
                    }
                    container.appendChild(group);
                }
            }

            if (player.jokerSeals > 0) {
                const group = document.createElement('div');
                group.className = 'seal-group';
                for (let i = 0; i < player.jokerSeals; i++) {
                    const j = document.createElement('div');
                    j.className = 'seal seal-joker';
                    group.appendChild(j);
                }
                container.appendChild(group);
            }

            if (player.blackSeals > 0) {
                const group = document.createElement('div');
                group.className = 'seal-group';
                for (let i = 0; i < player.blackSeals; i++) {
                    const b = document.createElement('div');
                    b.className = 'seal seal-black';
                    group.appendChild(b);
                }
                container.appendChild(group);
            }
        }
    }

    renderStatus() {
        const phaseLabel = {
            'BIDDING': 'Bidding',
            'PLAYING': 'Playing',
            'DISCARDING': 'Choosing'
        }[this.game.phase] || this.game.phase;
        const possessive = (i) => this.playerLabels[i] === 'You'
            ? 'Your' : `${this.playerLabels[i]}'s`;
        const trick = Math.min(this.game.tricksPlayed + 1, 15);
        const turnText = `${possessive(this.game.currentPlayerIdx)} turn`;
        document.getElementById('status-text').textContent =
            `${phaseLabel} · Trick ${trick}/15 · ${turnText}`;
    }

    renderSidebar() {
        // Round indicator
        const roundIdx = this.matchRound; // 0-indexed: round currently being played
        document.getElementById('round-indicator').textContent =
            `Round ${Math.min(roundIdx + 1, 3)} / 3`;

        // Round track pips
        const track = document.getElementById('round-track');
        track.innerHTML = '';
        for (let i = 0; i < 3; i++) {
            const pip = document.createElement('div');
            pip.className = 'round-pip';
            if (i < roundIdx) pip.classList.add('done');
            else if (i === roundIdx) pip.classList.add('current');
            pip.textContent = `R${i + 1}`;
            track.appendChild(pip);
        }

        // Standings (running totals — sorted by score, you highlighted)
        const standings = document.getElementById('standings');
        standings.innerHTML = '';
        const names = this.playerLabels;
        const entries = [0, 1, 2].map(i => ({
            idx: i,
            name: names[i],
            total: this.totalScores[i]
        }));
        entries.sort((a, b) => b.total - a.total);
        entries.forEach((e, rank) => {
            const row = document.createElement('div');
            row.className = 'score-row' + (e.idx === this.humanPlayer ? ' you' : '');
            const valClass = e.total > 0 ? 'pos' : (e.total < 0 ? 'neg' : '');
            row.innerHTML = `
                <div class="score-name">
                    <span class="score-rank">${rank + 1}</span>
                    ${e.name}
                </div>
                <div class="score-val ${valClass}">${e.total > 0 ? '+' : ''}${e.total}</div>
            `;
            standings.appendChild(row);
        });

        // By-round table
        const table = document.getElementById('rounds-table');
        table.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'rounds-head';
        head.innerHTML = `<span>Player</span><span>R1</span><span>R2</span><span>R3</span>`;
        table.appendChild(head);
        for (let i = 0; i < 3; i++) {
            const row = document.createElement('div');
            row.className = 'rounds-row';
            const r1 = this.roundScores[0]?.[i];
            const r2 = this.roundScores[1]?.[i];
            const r3 = this.roundScores[2]?.[i];
            const fmt = (v) => (v === undefined ? '—' : (v > 0 ? `+${v}` : `${v}`));
            const cls = (v) => v === undefined ? 'v pending' : 'v';
            row.innerHTML = `
                <div class="name">${names[i]}</div>
                <div class="${cls(r1)}">${fmt(r1)}</div>
                <div class="${cls(r2)}">${fmt(r2)}</div>
                <div class="${cls(r3)}">${fmt(r3)}</div>
            `;
            table.appendChild(row);
        }
    }

    // ---------- Interaction ----------
    handleCardClick(card) {
        if (this.busy) return;
        if (this.game.phase !== 'PLAYING') return;
        if (this.game.currentPlayerIdx !== this.humanPlayer) return;
        const action = card.id + 16;
        const legalMask = this.game.getLegalActions(this.humanPlayer);
        if (!legalMask[action]) return;
        this.playAction(action);
    }

    handleBid(action) {
        if (this.busy) return;
        if (this.game.phase !== 'BIDDING') return;
        if (this.game.currentPlayerIdx !== this.humanPlayer) return;
        const legalMask = this.game.getLegalActions(this.humanPlayer);
        if (!legalMask[action]) return;
        this.playAction(action);
    }

    handleDiscard(action) {
        if (this.busy) return;
        if (this.game.phase !== 'DISCARDING') return;
        if (this.game.currentPlayerIdx !== this.humanPlayer) return;
        const legalMask = this.game.getLegalActions(this.humanPlayer);
        if (!legalMask[action]) return;
        this.playAction(action);
    }

    playAction(action) {
        if (this.mode === 'online') { this.submitOnlineMove(action); return; }
        const trickWillComplete = this.game.phase === 'PLAYING' &&
            this.game.currentTrick.length === 2 &&
            action >= 16 && action <= 60;

        if (trickWillComplete) {
            this.busy = true; // lock input until the deferred step resolves
            const cardId = action - 16;
            this.showThirdCard(cardId, this.game.currentPlayerIdx);
            this.scheduleNext(() => this.resolveStep(action), 2000);
        } else {
            this.resolveStep(action);
        }
    }

    // Apply one action, render, then either end the round or schedule the next
    // turn. Always reached through the single nextTimer, so only one loop runs.
    resolveStep(action) {
        if (!this.gameStarted) return; // a stale timer fired after the round ended
        const result = this.game.step(action);
        this.render();
        if (result.done) this.handleRoundOver(result.info.scores);
        else this.scheduleNext(() => this.processNextTurn(), 500);
    }

    showThirdCard(cardId, playerIdx) {
        const container = document.getElementById('trick-area');
        const relPos = (playerIdx - this.humanPlayer + 3) % 3;
        const wrapper = document.createElement('div');
        wrapper.className = `trick-card trick-pos-${relPos}`;
        const color = Math.floor(cardId / 9);
        const value = (cardId % 9) + 1;
        const card = { id: cardId, color, value };
        wrapper.appendChild(this.createCardElement(card));
        container.appendChild(wrapper);
    }

    async processNextTurn() {
        if (!this.gameStarted) return;
        const currentPlayer = this.game.currentPlayerIdx;
        if (currentPlayer === this.humanPlayer) {
            this.busy = false; // hand control back to the human
            return;
        }

        const aiIndex = currentPlayer - 1;
        const difficulty = aiIndex === 0 ? this.ai1Difficulty : this.ai2Difficulty;
        const { model, pimc } = this.parseDifficulty(difficulty);

        let action;
        if (pimc !== null) {
            document.getElementById('status-text').textContent = 'Thinking…';
            try {
                action = await fetchPimcMove(this.game, currentPlayer, pimc, model);
            } catch (e) {
                console.warn('PIMC fetch failed, falling back to greedy:', e);
                const state = this.game.getState(currentPlayer);
                const mask = this.game.getLegalActions(currentPlayer);
                action = await this.ai[aiIndex].getAction(state, mask);
            }
        } else {
            const state = this.game.getState(currentPlayer);
            const mask = this.game.getLegalActions(currentPlayer);
            await new Promise(resolve => setTimeout(resolve, 300));
            action = await this.ai[aiIndex].getAction(state, mask);
        }

        const trickWillComplete = this.game.phase === 'PLAYING' &&
            this.game.currentTrick.length === 2 &&
            action >= 16 && action <= 60;

        if (!this.gameStarted) return; // round may have ended during the awaits

        if (trickWillComplete) {
            this.showThirdCard(action - 16, currentPlayer);
            this.scheduleNext(() => this.resolveStep(action), 2000);
        } else {
            this.resolveStep(action);
        }
    }

    handleRoundOver(scores) {
        if (!this.gameStarted) return; // ignore a duplicate round-end
        this.gameStarted = false;
        this.busy = false;
        clearTimeout(this.nextTimer);
        this.roundScores.push(scores);
        for (let i = 0; i < 3; i++) this.totalScores[i] += scores[i];
        this.matchRound++;

        // Re-render sidebar with updated scores
        this.renderSidebar();

        const container = document.getElementById('game-over');
        container.classList.remove('hidden');

        const playerNames = this.playerLabels;
        const isMatchOver = this.matchRound >= 3;

        let html = '';
        if (isMatchOver) {
            const maxScore = Math.max(...this.totalScores);
            const winnerIdx = this.totalScores.indexOf(maxScore);
            html = `<h3>Match Complete</h3>`;
            html += `<h2>${playerNames[winnerIdx]} ${winnerIdx === this.humanPlayer ? 'win' : 'wins'} ✦</h2>`;
        } else {
            html = `<h3>Round ${this.matchRound} Complete</h3>`;
            html += `<h2>Next: ${playerNames[this.matchRound]} leads</h2>`;
        }

        html += '<div class="scores">';
        html += `<div class="score-table-row head">
            <span>Player</span>
            <span>Round ${this.matchRound}</span>
            <span>Total</span>
        </div>`;

        for (let i = 0; i < 3; i++) {
            const isWinner = isMatchOver && (i === this.totalScores.indexOf(Math.max(...this.totalScores)));
            const winClass = isWinner ? ' winner' : '';
            const mark = isWinner ? ' ✦' : '';
            const fmt = (v) => v > 0 ? `+${v}` : `${v}`;
            html += `<div class="score-table-row${winClass}">
                <span>${playerNames[i]}${mark}</span>
                <span class="v">${fmt(scores[i])}</span>
                <span class="v">${fmt(this.totalScores[i])}</span>
            </div>`;
        }
        html += '</div>';

        container.innerHTML = html;

        const actionBtn = document.createElement('button');
        actionBtn.className = 'btn';
        if (isMatchOver) {
            actionBtn.textContent = 'Back to Lobby';
            actionBtn.addEventListener('click', () => {
                if (actionBtn.disabled) return;
                actionBtn.disabled = true; // ignore repeat taps
                this.matchRound = 0;
                this.totalScores = [0, 0, 0];
                this.roundScores = [];
                this.showDifficultySelect();
            });
        } else {
            actionBtn.textContent = 'Next Round';
            actionBtn.addEventListener('click', () => {
                if (actionBtn.disabled) return;
                actionBtn.disabled = true; // ignore repeat taps -> only one startRound
                document.getElementById('game-over').classList.add('hidden');
                document.getElementById('loading').classList.remove('hidden');
                setTimeout(() => this.startRound(), 400);
            });
        }
        container.appendChild(actionBtn);
    }

    // ===================== Online multiplayer =====================

    // Build a client-side WizardExtremeGame view-model from the server's redacted
    // view. Only your own hand is known; opponents are placeholder cards of the
    // right count (rendered face-down). getLegalActions(you) is exact because it
    // depends only on your hand + public state.
    hydrateGame(view) {
        const g = new WizardExtremeGame();
        g.phase = view.phase;
        g.tricksPlayed = view.tricksPlayed;
        g.currentPlayerIdx = view.currentSeat;
        g.poolSeals = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
        for (let c = 0; c < 5; c++) g.poolSeals[c] = view.poolSeals[c];
        g.jokerPool = view.jokerPool;
        g.roundHistoryMask = new Array(TOTAL_CARDS).fill(0);
        g.pendingLeadColor = view.pendingLeadColor;
        g.pendingWinCard = (view.pendingWinCard !== null && view.pendingWinCard !== undefined)
            ? new Card(Math.floor(view.pendingWinCard / 9), (view.pendingWinCard % 9) + 1)
            : null;
        g.currentTrick = view.currentTrick.map(([pi, cid]) =>
            ({ playerIdx: pi, card: new Card(Math.floor(cid / 9), (cid % 9) + 1) }));

        for (let i = 0; i < 3; i++) {
            const pv = view.players[i];
            const p = g.players[i];
            for (let c = 0; c < 5; c++) { p.seals[c] = pv.seals[c]; p.initialSeals[c] = pv.initialSeals[c]; }
            p.jokerSeals = pv.jokerSeals;
            p.blackSeals = pv.blackSeals;
            p.hasPassedBidding = pv.hasPassed;
            if (i === view.yourSeat && pv.hand) {
                p.hand = pv.hand.map(cid => new Card(Math.floor(cid / 9), (cid % 9) + 1));
            } else {
                // placeholder cards — only the count is rendered (face-down)
                p.hand = Array.from({ length: pv.handCount }, () => new Card(0, 1));
            }
        }
        this.game = g;
    }

    startOnline() {
        const nick = (document.getElementById('online-nick')?.value || '').trim() || 'Player';
        this.mode = 'online';
        this.matchRound = 0;
        this.totalScores = [0, 0, 0];
        this.roundScores = [];
        document.getElementById('difficulty-select').classList.add('hidden');
        this.showWaiting('Joining…', false);
        OnlineNet.joinQueue(nick).then(res => {
            this.online.playerId = res.playerId;
            this.online.token = res.token;
            this.online.gameId = null;
            localStorage.setItem('we_online', JSON.stringify(
                { playerId: res.playerId, token: res.token }));
            if (res.gameId) {
                this.enterOnlineGame(res.gameId);
            } else {
                this.showWaiting('Waiting for players…', true);
                this.pollQueue();
            }
        }).catch(e => this.showWaiting('Error: ' + e.message, false));
    }

    pollQueue() {
        if (this.mode !== 'online' || this.online.gameId) return;
        OnlineNet.queueStatus(this.online.playerId).then(s => {
            if (this.online.gameId) return;
            if (s.status === 'matched' && s.gameId) this.enterOnlineGame(s.gameId);
            else setTimeout(() => this.pollQueue(), OnlineNet.POLL_INTERVAL_MS);
        }).catch(() => setTimeout(() => this.pollQueue(), OnlineNet.POLL_INTERVAL_MS));
    }

    fillWithAI() {
        OnlineNet.fillWithAI(this.online.playerId, this.online.token)
            .then(res => { if (res.gameId) this.enterOnlineGame(res.gameId); })
            .catch(e => this.showWaiting('Error: ' + e.message, true));
    }

    enterOnlineGame(gameId) {
        this.online.gameId = gameId;
        this.online.version = -1;
        this.online.lastMatchRound = 0;
        this.roundScores = [];
        localStorage.setItem('we_online', JSON.stringify(
            { playerId: this.online.playerId, token: this.online.token, gameId }));
        this.hideWaiting();
        document.getElementById('game-area').classList.remove('hidden');
        document.getElementById('game-over').classList.add('hidden');
        this.gameStarted = true;
        this.busy = true;
        this.online.polling = true;
        this.pollGame();
    }

    pollGame() {
        if (this.mode !== 'online' || !this.online.polling) return;
        OnlineNet.getState(this.online.gameId, this.online.token, this.online.version)
            .then(view => { if (view.changed !== false) this.applyView(view); })
            .catch(e => {
                if (/404|not found/i.test(e.message)) {
                    this.online.polling = false;
                    localStorage.removeItem('we_online');
                    this.backToOnlineLobby();
                }
            })
            .finally(() => {
                if (this.online.polling) setTimeout(() => this.pollGame(), OnlineNet.POLL_INTERVAL_MS);
            });
    }

    submitOnlineMove(action) {
        if (this.busy) return;
        this.busy = true; // lock until the move response arrives
        OnlineNet.move(this.online.gameId, this.online.token, action)
            .then(view => this.applyView(view))
            .catch(e => { this.busy = false; console.warn('move rejected:', e.message); });
    }

    applyView(view) {
        this.online.version = view.version;
        this.humanPlayer = view.yourSeat;
        this.matchRound = view.matchRound;
        this.totalScores = view.totalScores;
        this.playerLabels = view.players.map((p, i) => i === view.yourSeat ? 'You' : p.nickname);
        this.hydrateGame(view);

        for (let slot = 1; slot <= 2; slot++) {
            const seat = (view.yourSeat + slot) % 3;
            const p = view.players[seat];
            const nameEl = document.getElementById(`opponent-${slot}-name`);
            const metaEl = document.getElementById(`opponent-${slot}-meta`);
            if (nameEl) nameEl.textContent = p.nickname;
            if (metaEl) metaEl.textContent = p.type === 'ai' ? 'Crusher · K=10' : 'Player';
        }

        // Capture a finished round exactly once (a round can't complete twice
        // between polls, so we never miss one).
        if (view.roundScores) {
            const completed = view.status === 'done' ? 3 : view.matchRound;
            if (this.roundScores.length < completed) {
                this.roundScores.push(view.roundScores);
                if (view.status !== 'done') this.onlineRoundSummary(view.roundScores);
            }
        }

        this.busy = !view.yourTurn;
        this.render();
        if (view.status === 'done') { this.online.polling = false; this.onlineMatchOver(); }
    }

    // ---- Online lobby / waiting / overlays ----
    showWaiting(text, showFill) {
        const wait = document.getElementById('online-wait');
        document.getElementById('difficulty-select').classList.add('hidden');
        document.getElementById('game-area').classList.add('hidden');
        wait.classList.remove('hidden');
        document.getElementById('online-wait-text').textContent = text;
        document.getElementById('fill-ai-btn').classList.toggle('hidden', !showFill);
    }

    hideWaiting() {
        document.getElementById('online-wait').classList.add('hidden');
    }

    backToOnlineLobby() {
        this.mode = 'local';
        this.online = { playerId: null, token: null, gameId: null,
                        version: -1, polling: false, lastMatchRound: 0 };
        this.gameStarted = false;
        this.hideWaiting();
        document.getElementById('game-over').classList.add('hidden');
        this.showDifficultySelect();
    }

    onlineRoundSummary(scores) {
        const container = document.getElementById('game-over');
        container.classList.remove('hidden');
        let html = `<h3>Round ${this.matchRound} Complete</h3>`;
        html += `<h2>Round ${this.matchRound + 1} begins…</h2>`;
        html += this.scoreTableHtml(scores);
        container.innerHTML = html;
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = 'Continue';
        btn.addEventListener('click', () => container.classList.add('hidden'));
        container.appendChild(btn);
    }

    onlineMatchOver() {
        const container = document.getElementById('game-over');
        container.classList.remove('hidden');
        const maxScore = Math.max(...this.totalScores);
        const winnerIdx = this.totalScores.indexOf(maxScore);
        let html = `<h3>Match Complete</h3>`;
        html += `<h2>${this.playerLabels[winnerIdx]} ${winnerIdx === this.humanPlayer ? 'win' : 'wins'} ✦</h2>`;
        html += this.scoreTableHtml(this.roundScores[this.roundScores.length - 1] || [0, 0, 0]);
        container.innerHTML = html;
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = 'Back to Lobby';
        btn.addEventListener('click', () => {
            localStorage.removeItem('we_online');
            this.backToOnlineLobby();
        });
        container.appendChild(btn);
    }

    scoreTableHtml(roundScores) {
        const fmt = (v) => v > 0 ? `+${v}` : `${v}`;
        let html = '<div class="scores">';
        html += `<div class="score-table-row head"><span>Player</span><span>Round</span><span>Total</span></div>`;
        for (let i = 0; i < 3; i++) {
            html += `<div class="score-table-row">
                <span>${this.playerLabels[i]}</span>
                <span class="v">${fmt(roundScores[i])}</span>
                <span class="v">${fmt(this.totalScores[i])}</span>
            </div>`;
        }
        return html + '</div>';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const ui = new GameUI();
    ui.init();
});
