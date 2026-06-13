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
        this.ai1Difficulty = 'easy';
        this.ai2Difficulty = 'hard';
    }

    async init() {
        this.setupEventListeners();
        this.showDifficultySelect();
    }

    setupEventListeners() {
        document.getElementById('start-game-btn')?.addEventListener('click', () => this.startMatch());

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

    async startMatch() {
        this.ai1Difficulty = document.getElementById('ai1-difficulty').value;
        this.ai2Difficulty = document.getElementById('ai2-difficulty').value;

        document.getElementById('difficulty-select').classList.add('hidden');
        document.getElementById('loading').classList.remove('hidden');

        await this.ai[0].loadModel(this.ai1Difficulty);
        await this.ai[1].loadModel(this.ai2Difficulty);

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
        const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
        document.getElementById('opponent-1-name').textContent = 'AI 1';
        document.getElementById('opponent-1-meta').textContent = cap(this.ai1Difficulty);
        document.getElementById('opponent-2-name').textContent = 'AI 2';
        document.getElementById('opponent-2-meta').textContent = cap(this.ai2Difficulty);

        this.game.startingPlayerOffset = this.matchRound;
        this.game.reset();
        this.gameStarted = true;

        this.render();
        this.processNextTurn();
    }

    showDifficultySelect() {
        document.getElementById('difficulty-select').classList.remove('hidden');
        document.getElementById('game-area').classList.add('hidden');
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('game-over').classList.add('hidden');
        this.gameStarted = false;
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
        for (let pIdx = 1; pIdx <= 2; pIdx++) {
            const container = document.getElementById(`opponent-${pIdx}-hand`);
            container.innerHTML = '';

            const player = this.game.players[pIdx];
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
            const wrapper = document.createElement('div');
            wrapper.className = `trick-card trick-pos-${playerIdx}`;
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

        // Player + opponent seals
        for (let pIdx = 0; pIdx < 3; pIdx++) {
            const player = this.game.players[pIdx];
            const containerId = pIdx === 0 ? 'player-seals' : `opponent-${pIdx}-seals`;
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
        const playerNames = ['Your', "AI 1's", "AI 2's"];
        const trick = Math.min(this.game.tricksPlayed + 1, 15);
        const turnText = this.game.phase === 'BIDDING'
            ? `${playerNames[this.game.currentPlayerIdx]} turn`
            : `${playerNames[this.game.currentPlayerIdx]} turn`;
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
        const names = ['You', 'AI 1', 'AI 2'];
        const entries = [0, 1, 2].map(i => ({
            idx: i,
            name: names[i],
            total: this.totalScores[i]
        }));
        entries.sort((a, b) => b.total - a.total);
        entries.forEach((e, rank) => {
            const row = document.createElement('div');
            row.className = 'score-row' + (e.idx === 0 ? ' you' : '');
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
        if (this.game.phase !== 'PLAYING') return;
        if (this.game.currentPlayerIdx !== this.humanPlayer) return;
        const action = card.id + 16;
        const legalMask = this.game.getLegalActions(this.humanPlayer);
        if (!legalMask[action]) return;
        this.playAction(action);
    }

    handleBid(action) {
        if (this.game.phase !== 'BIDDING') return;
        if (this.game.currentPlayerIdx !== this.humanPlayer) return;
        const legalMask = this.game.getLegalActions(this.humanPlayer);
        if (!legalMask[action]) return;
        this.playAction(action);
    }

    handleDiscard(action) {
        if (this.game.phase !== 'DISCARDING') return;
        if (this.game.currentPlayerIdx !== this.humanPlayer) return;
        const legalMask = this.game.getLegalActions(this.humanPlayer);
        if (!legalMask[action]) return;
        this.playAction(action);
    }

    playAction(action) {
        const trickWillComplete = this.game.phase === 'PLAYING' &&
            this.game.currentTrick.length === 2 &&
            action >= 16 && action <= 60;

        if (trickWillComplete) {
            const cardId = action - 16;
            this.showThirdCard(cardId, this.game.currentPlayerIdx);
            setTimeout(() => {
                const result = this.game.step(action);
                this.render();
                if (result.done) this.handleRoundOver(result.info.scores);
                else setTimeout(() => this.processNextTurn(), 500);
            }, 2000);
        } else {
            const result = this.game.step(action);
            this.render();
            if (result.done) this.handleRoundOver(result.info.scores);
            else setTimeout(() => this.processNextTurn(), 500);
        }
    }

    showThirdCard(cardId, playerIdx) {
        const container = document.getElementById('trick-area');
        const wrapper = document.createElement('div');
        wrapper.className = `trick-card trick-pos-${playerIdx}`;
        const color = Math.floor(cardId / 9);
        const value = (cardId % 9) + 1;
        const card = { id: cardId, color, value };
        wrapper.appendChild(this.createCardElement(card));
        container.appendChild(wrapper);
    }

    async processNextTurn() {
        if (!this.gameStarted) return;
        const currentPlayer = this.game.currentPlayerIdx;
        if (currentPlayer === this.humanPlayer) return;

        const aiIndex = currentPlayer - 1;
        const state = this.game.getState(currentPlayer);
        const mask = this.game.getLegalActions(currentPlayer);
        const action = await this.ai[aiIndex].getAction(state, mask);

        await new Promise(resolve => setTimeout(resolve, 300));

        const trickWillComplete = this.game.phase === 'PLAYING' &&
            this.game.currentTrick.length === 2 &&
            action >= 16 && action <= 60;

        if (trickWillComplete) {
            const cardId = action - 16;
            this.showThirdCard(cardId, currentPlayer);
            setTimeout(() => {
                const result = this.game.step(action);
                this.render();
                if (result.done) this.handleRoundOver(result.info.scores);
                else setTimeout(() => this.processNextTurn(), 500);
            }, 2000);
        } else {
            const result = this.game.step(action);
            this.render();
            if (result.done) this.handleRoundOver(result.info.scores);
            else setTimeout(() => this.processNextTurn(), 500);
        }
    }

    handleRoundOver(scores) {
        this.gameStarted = false;
        this.roundScores.push(scores);
        for (let i = 0; i < 3; i++) this.totalScores[i] += scores[i];
        this.matchRound++;

        // Re-render sidebar with updated scores
        this.renderSidebar();

        const container = document.getElementById('game-over');
        container.classList.remove('hidden');

        const playerNames = ['You', 'AI 1', 'AI 2'];
        const isMatchOver = this.matchRound >= 3;

        let html = '';
        if (isMatchOver) {
            const maxScore = Math.max(...this.totalScores);
            const winnerIdx = this.totalScores.indexOf(maxScore);
            html = `<h3>Match Complete</h3>`;
            html += `<h2>${playerNames[winnerIdx]} ${winnerIdx === 0 ? 'win' : 'wins'} ✦</h2>`;
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
                this.matchRound = 0;
                this.totalScores = [0, 0, 0];
                this.roundScores = [];
                this.showDifficultySelect();
            });
        } else {
            actionBtn.textContent = 'Next Round';
            actionBtn.addEventListener('click', () => {
                document.getElementById('game-over').classList.add('hidden');
                document.getElementById('loading').classList.remove('hidden');
                setTimeout(() => this.startRound(), 400);
            });
        }
        container.appendChild(actionBtn);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const ui = new GameUI();
    ui.init();
});
