// Wizard Extreme UI Controller
// Handles rendering and user interaction

class GameUI {
    constructor() {
        this.game = new WizardExtremeGame();
        this.ai = [new WizardAI(), new WizardAI()]; // AI for players 1 and 2
        this.humanPlayer = 0;
        this.selectedCard = null;
        this.gameStarted = false;
        this.autoPlayTimeout = null;

        // Match state (3 games per match)
        this.matchRound = 0; // 0, 1, 2 (each round, starting player rotates)
        this.totalScores = [0, 0, 0]; // Cumulative scores across all rounds
        this.roundScores = []; // Array of score arrays for each round
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

        // Bid buttons
        document.querySelectorAll('.bid-btn').forEach(btn => {
            btn.addEventListener('click', () => this.handleBid(parseInt(btn.dataset.action)));
        });
    }

    async startMatch() {
        // Get selected difficulties
        this.ai1Difficulty = document.getElementById('ai1-difficulty').value;
        this.ai2Difficulty = document.getElementById('ai2-difficulty').value;

        // Show loading
        document.getElementById('difficulty-select').classList.add('hidden');
        document.getElementById('loading').classList.remove('hidden');

        // Load AI models
        console.log(`Loading AI 1: ${this.ai1Difficulty}, AI 2: ${this.ai2Difficulty}`);
        await this.ai[0].loadModel(this.ai1Difficulty);
        await this.ai[1].loadModel(this.ai2Difficulty);

        // Reset match state
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

        // Update opponent labels
        document.querySelector('.opponents-row .opponent:first-child .opponent-name').textContent =
            `AI 1 (${this.ai1Difficulty.charAt(0).toUpperCase() + this.ai1Difficulty.slice(1)})`;
        document.querySelector('.opponents-row .opponent:last-child .opponent-name').textContent =
            `AI 2 (${this.ai2Difficulty.charAt(0).toUpperCase() + this.ai2Difficulty.slice(1)})`;

        // Set starting player based on round (rotate seats)
        this.game.startingPlayerOffset = this.matchRound;
        this.game.reset();
        this.gameStarted = true;

        // Update status to show round
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
                legalMask[card.id + 6];

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
            // Fan parameters
            const angleStep = 4;
            const startAngle = -((count - 1) * angleStep) / 2;

            for (let i = 0; i < count; i++) {
                const cardBack = document.createElement('div');
                cardBack.className = 'card card-back';

                // Fan rotation and arc
                const angle = startAngle + (i * angleStep);
                const translateY = Math.abs(angle) * 0.5;

                cardBack.style.transform = `rotate(${angle}deg) translateY(${translateY}px)`;
                cardBack.style.transformOrigin = 'bottom center';

                // Overlap for compactness (except first card)
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
        const container = document.getElementById('bid-buttons');
        const isHumanBidding = this.game.phase === 'BIDDING' &&
            this.game.currentPlayerIdx === this.humanPlayer &&
            !this.game.players[this.humanPlayer].hasPassedBidding;

        if (isHumanBidding) {
            container.classList.remove('hidden');
            const legalMask = this.game.getLegalActions(this.humanPlayer);

            document.querySelectorAll('.bid-btn').forEach(btn => {
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
            for (let c = 0; c < 5; c++) {
                const count = this.game.poolSeals[c];
                for (let i = 0; i < count; i++) {
                    const seal = document.createElement('div');
                    seal.className = `seal seal-color-${c}`;
                    poolContainer.appendChild(seal);
                }
            }
        } else {
            poolContainer.classList.add('hidden');
        }

        // Player seals - individual circles
        for (let pIdx = 0; pIdx < 3; pIdx++) {
            const player = this.game.players[pIdx];
            const containerId = pIdx === 0 ? 'player-seals' : `opponent-${pIdx}-seals`;
            const container = document.getElementById(containerId);
            if (!container) continue;

            container.innerHTML = '';
            // Colored seals
            for (let c = 0; c < 5; c++) {
                const count = player.seals[c];
                for (let i = 0; i < count; i++) {
                    const seal = document.createElement('div');
                    seal.className = `seal seal-color-${c}`;
                    container.appendChild(seal);
                }
            }
            // Black seals
            for (let i = 0; i < player.blackSeals; i++) {
                const black = document.createElement('div');
                black.className = 'seal seal-black';
                container.appendChild(black);
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
        // Rank emojis from weakest (1) to strongest (9)
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

        const action = card.id + 6;
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

    playAction(action) {
        // Check if this will complete a trick (3rd card)
        const trickWillComplete = this.game.phase === 'PLAYING' &&
            this.game.currentTrick.length === 2;

        if (trickWillComplete && action >= 6) {
            // Show the 3rd card BEFORE step clears it
            const cardId = action - 6;
            this.showThirdCard(cardId, this.game.currentPlayerIdx);

            // Wait 2 seconds to show all 3 cards, then process
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
        // Manually add the 3rd card to the trick display
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
            this.game.currentTrick.length === 2;

        if (trickWillComplete && action >= 6) {
            // Show the 3rd card first
            const cardId = action - 6;
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

        // Update cumulative scores
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
            const winner = this.totalScores.indexOf(Math.max(...this.totalScores));
            html = `<h2>🏆 Match Results 🏆</h2>`;
            html += `<h3 style="color:#a0a0a0; margin-bottom:15px">Final Totals after 3 Games</h3>`;
        } else {
            html = `<h2>Round ${this.matchRound} Complete</h2>`;
            html += `<h3 style="color:#a0a0a0; margin-bottom:15px">Next Round: Player ${['You', 'AI 1', 'AI 2'][this.matchRound]} starts</h3>`;
        }

        html += '<div class="scores" style="text-align:left; display:inline-block; min-width:300px">';

        // Header row
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
                setTimeout(() => this.startRound(), 500); // Small delay to show loading
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
