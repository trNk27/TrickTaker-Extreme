// Wizard Extreme UI Controller
// Handles rendering and user interaction (v2 - with Joker Seals and Decision Step)

class GameUI {
    constructor() {
        this.game = new WizardExtremeGame();
        this.ai = [new WizardAI(), new WizardAI()]; // AI for players 1 and 2
        this.humanPlayer = 0;
        this.selectedCard = null;
        this.gameStarted = false;
        this.autoPlayTimeout = null;

        // Match state (3 games per match)
        this.matchRound = 0;
        this.totalScores = [0, 0, 0];
        this.roundScores = [];
        this.ai1Difficulty = 'medium';
        this.ai2Difficulty = 'medium';
    }

    async init() {
        this.setupEventListeners();
        this.showDifficultySelect();
    }

    setupEventListeners() {
        // Start game button
        document.getElementById('start-game-btn')?.addEventListener('click', () => this.startMatch());

        // Bid buttons (0-4: take seal, 5: pass)
        document.querySelectorAll('.bid-btn').forEach(btn => {
            btn.addEventListener('click', () => this.handleBid(parseInt(btn.dataset.action)));
        });

        // Steal buttons (6-15)
        document.querySelectorAll('.steal-btn').forEach(btn => {
            btn.addEventListener('click', () => this.handleBid(parseInt(btn.dataset.action)));
        });

        // Discard buttons (61-66)
        document.querySelectorAll('.discard-btn').forEach(btn => {
            btn.addEventListener('click', () => this.handleDiscard(parseInt(btn.dataset.action)));
        });
    }

    async startMatch() {
        this.ai1Difficulty = document.getElementById('ai1-difficulty').value;
        this.ai2Difficulty = document.getElementById('ai2-difficulty').value;

        document.getElementById('difficulty-select').classList.add('hidden');
        document.getElementById('loading').classList.remove('hidden');

        console.log(`Loading AI 1: ${this.ai1Difficulty}, AI 2: ${this.ai2Difficulty}`);
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

        document.querySelector('.opponents-row .opponent:first-child .opponent-name').textContent =
            `AI 1 (${this.ai1Difficulty.charAt(0).toUpperCase() + this.ai1Difficulty.slice(1)})`;
        document.querySelector('.opponents-row .opponent:last-child .opponent-name').textContent =
            `AI 2 (${this.ai2Difficulty.charAt(0).toUpperCase() + this.ai2Difficulty.slice(1)})`;

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
                legalMask[card.id + 16]; // Actions 16-60 for cards

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
                cardBack.className = 'card card-back';

                const angle = startAngle + (i * angleStep);
                const translateY = Math.abs(angle) * 0.5;

                cardBack.style.transform = `rotate(${angle}deg) translateY(${translateY}px)`;
                cardBack.style.transformOrigin = 'bottom center';

                if (i > 0) {
                    cardBack.style.marginLeft = '-22px';
                }

                container.appendChild(cardBack);
            }
        }
    }

    renderTrick() {
        const container = document.getElementById('trick-area');
        container.innerHTML = '';

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
            bidContainer.classList.remove('hidden');
            stealContainer.classList.remove('hidden');
            const legalMask = this.game.getLegalActions(this.humanPlayer);

            // Bid buttons (0-5)
            document.querySelectorAll('.bid-btn').forEach(btn => {
                const action = parseInt(btn.dataset.action);
                btn.disabled = !legalMask[action];
            });

            // Steal buttons (6-15)
            document.querySelectorAll('.steal-btn').forEach(btn => {
                const action = parseInt(btn.dataset.action);
                btn.disabled = !legalMask[action];
            });
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

            // Discard buttons (61-66)
            document.querySelectorAll('.discard-btn').forEach(btn => {
                const action = parseInt(btn.dataset.action);
                btn.disabled = !legalMask[action];
            });
        } else {
            container.classList.add('hidden');
        }
    }

    renderSeals() {
        // Pool seals - only show during bidding
        const poolContainer = document.getElementById('pool-seals');
        if (this.game.phase === 'BIDDING') {
            poolContainer.classList.remove('hidden');
            poolContainer.innerHTML = '<div class="seal-label">Pool:</div>';

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

        // Player seals
        for (let pIdx = 0; pIdx < 3; pIdx++) {
            const player = this.game.players[pIdx];
            const containerId = pIdx === 0 ? 'player-seals' : `opponent-${pIdx}-seals`;
            const container = document.getElementById(containerId);
            if (!container) continue;

            container.innerHTML = '';

            // Colored seals
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

            // Joker seals (white)
            if (player.jokerSeals > 0) {
                const group = document.createElement('div');
                group.className = 'seal-group';
                for (let i = 0; i < player.jokerSeals; i++) {
                    const joker = document.createElement('div');
                    joker.className = 'seal seal-joker';
                    group.appendChild(joker);
                }
                container.appendChild(group);
            }

            // Black seals
            if (player.blackSeals > 0) {
                const group = document.createElement('div');
                group.className = 'seal-group';
                for (let i = 0; i < player.blackSeals; i++) {
                    const black = document.createElement('div');
                    black.className = 'seal seal-black';
                    group.appendChild(black);
                }
                container.appendChild(group);
            }
        }
    }

    renderStatus() {
        const status = document.getElementById('status');
        const playerNames = ['You', 'AI 1', 'AI 2'];
        const currentPlayer = playerNames[this.game.currentPlayerIdx];
        const phase = this.game.phase;
        const trick = this.game.tricksPlayed + 1;

        status.textContent = `${phase} | Trick ${trick}/15 | ${currentPlayer}'s turn`;
    }

    createCardElement(card) {
        const rankEmojis = ['🐜', '🐁', '🐇', '🦊', '🐺', '🦅', '🦁', '🐉', '👑'];
        const emoji = rankEmojis[card.value - 1];

        const el = document.createElement('div');
        el.className = `card card-color-${card.color}`;
        el.innerHTML = `<span class="card-value">${card.value}</span><span class="card-emoji">${emoji}</span>`;
        return el;
    }

    handleCardClick(card) {
        if (this.game.phase !== 'PLAYING') return;
        if (this.game.currentPlayerIdx !== this.humanPlayer) return;

        const action = card.id + 16; // Actions 16-60 for cards
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
        // Check if this will complete a trick (3rd card)
        const trickWillComplete = this.game.phase === 'PLAYING' &&
            this.game.currentTrick.length === 2 &&
            action >= 16 && action <= 60;

        if (trickWillComplete) {
            // Show the 3rd card BEFORE step clears it
            const cardId = action - 16;
            this.showThirdCard(cardId, this.game.currentPlayerIdx);

            // Wait to show all 3 cards, then process
            setTimeout(() => {
                const result = this.game.step(action);
                this.render();
                if (result.done) {
                    this.handleRoundOver(result.info.scores);
                } else {
                    setTimeout(() => this.processNextTurn(), 500);
                }
            }, 2000);
        } else {
            const result = this.game.step(action);
            this.render();
            if (result.done) {
                this.handleRoundOver(result.info.scores);
            } else {
                setTimeout(() => this.processNextTurn(), 500);
            }
        }
    }

    showThirdCard(cardId, playerIdx) {
        const rankEmojis = ['🐜', '🐁', '🐇', '🦊', '🐺', '🦅', '🦁', '🐉', '👑'];
        const container = document.getElementById('trick-area');
        const wrapper = document.createElement('div');
        wrapper.className = `trick-card trick-pos-${playerIdx}`;
        const cardEl = document.createElement('div');
        const color = Math.floor(cardId / 9);
        const value = (cardId % 9) + 1;
        const emoji = rankEmojis[value - 1];
        cardEl.className = `card card-color-${color}`;
        cardEl.innerHTML = `<span class="card-value">${value}</span><span class="card-emoji">${emoji}</span>`;
        wrapper.appendChild(cardEl);
        container.appendChild(wrapper);
    }

    async processNextTurn() {
        if (!this.gameStarted) return;

        const currentPlayer = this.game.currentPlayerIdx;

        // If human's turn, wait for input
        if (currentPlayer === this.humanPlayer) {
            return;
        }

        // AI turn
        const aiIndex = currentPlayer - 1;
        const state = this.game.getState(currentPlayer);
        const mask = this.game.getLegalActions(currentPlayer);

        const action = await this.ai[aiIndex].getAction(state, mask);

        // Small delay for visual effect
        await new Promise(resolve => setTimeout(resolve, 300));

        // Check if this will complete a trick
        const trickWillComplete = this.game.phase === 'PLAYING' &&
            this.game.currentTrick.length === 2 &&
            action >= 16 && action <= 60;

        if (trickWillComplete) {
            // Show the 3rd card first
            const cardId = action - 16;
            this.showThirdCard(cardId, currentPlayer);

            // Wait then process
            setTimeout(() => {
                const result = this.game.step(action);
                this.render();
                if (result.done) {
                    this.handleRoundOver(result.info.scores);
                } else {
                    setTimeout(() => this.processNextTurn(), 500);
                }
            }, 2000);
        } else {
            const result = this.game.step(action);
            this.render();
            if (result.done) {
                this.handleRoundOver(result.info.scores);
            } else {
                setTimeout(() => this.processNextTurn(), 500);
            }
        }
    }

    handleRoundOver(scores) {
        this.gameStarted = false;

        this.roundScores.push(scores);
        for (let i = 0; i < 3; i++) {
            this.totalScores[i] += scores[i];
        }

        this.matchRound++;

        const container = document.getElementById('game-over');
        container.classList.remove('hidden');

        const playerNames = ['You', 'AI 1', 'AI 2'];
        const isMatchOver = this.matchRound >= 3;

        let html = '';
        if (isMatchOver) {
            html = `<h2>🏆 Match Results 🏆</h2>`;
            html += `<h3 style="color:#a0a0a0; margin-bottom:15px">Final Totals after 3 Games</h3>`;
        } else {
            html = `<h2>Round ${this.matchRound} Complete</h2>`;
            html += `<h3 style="color:#a0a0a0; margin-bottom:15px">Next Round: Player ${['You', 'AI 1', 'AI 2'][this.matchRound]} starts</h3>`;
        }

        html += '<div class="scores" style="text-align:left; display:inline-block; min-width:300px">';

        html += '<div class="score-row" style="border-bottom:1px solid #444; margin-bottom:10px; font-size:14px; color:#aaa">' +
            '<span style="display:inline-block; width:100px">Player</span>' +
            '<span style="display:inline-block; width:80px">Round</span>' +
            '<span style="display:inline-block; width:80px">Total</span></div>';

        for (let i = 0; i < 3; i++) {
            const isWinner = isMatchOver && (i === this.totalScores.indexOf(Math.max(...this.totalScores)));
            const style = isWinner ? 'color:#4ade80; font-weight:bold' : '';
            const crown = isWinner ? ' 👑' : '';

            html += `<div class="score-row" style="${style}">
                <span style="display:inline-block; width:100px">${playerNames[i]}</span>
                <span style="display:inline-block; width:80px">${scores[i] > 0 ? '+' : ''}${scores[i]}</span>
                <span style="display:inline-block; width:80px">${this.totalScores[i]}</span>
                ${crown}
            </div>`;
        }
        html += '</div>';

        container.innerHTML = html + '<br><br>';

        const actionBtn = document.createElement('button');
        actionBtn.className = 'btn';

        if (isMatchOver) {
            actionBtn.textContent = 'Back to Lobby';
            actionBtn.addEventListener('click', () => this.showDifficultySelect());
        } else {
            actionBtn.textContent = 'Start Next Round';
            actionBtn.addEventListener('click', () => {
                document.getElementById('loading').classList.remove('hidden');
                document.getElementById('game-over').classList.add('hidden');
                setTimeout(() => this.startRound(), 500);
            });
        }
        container.appendChild(actionBtn);
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    const ui = new GameUI();
    ui.init();
});
