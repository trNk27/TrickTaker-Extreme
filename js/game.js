// Wizard Extreme Game Engine - JavaScript Port
// Ported from Python game_engine.py

const NUM_PLAYERS = 3;
const NUM_COLORS = 5;
const CARDS_PER_COLOR = 9;
const TOTAL_CARDS = 45;
const TRICKS_PER_ROUND = 15;

const COLOR_RED = 0; // Trump
const COLOR_NAMES = { 0: "Red", 1: "Blue", 2: "Yellow", 3: "Green", 4: "Purple" };

class Card {
    constructor(color, value) {
        this.color = color;
        this.value = value;
        this.id = color * CARDS_PER_COLOR + (value - 1);
    }
}

class Player {
    constructor(playerId) {
        this.id = playerId;
        this.hand = [];
        this.seals = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
        this.initialSeals = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
        this.blackSeals = 0;
        this.hasPassedBidding = false;
        this.playedCardsMask = new Array(TOTAL_CARDS).fill(0);
    }

    reset() {
        this.hand = [];
        this.seals = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
        this.initialSeals = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
        this.blackSeals = 0;
        this.hasPassedBidding = false;
        this.playedCardsMask.fill(0);
    }
}

class WizardExtremeGame {
    constructor() {
        this.players = [new Player(0), new Player(1), new Player(2)];
        this.roundHistoryMask = new Array(TOTAL_CARDS).fill(0);
        this.currentTrick = []; // Array of {playerIdx, card}
        this.phase = "BIDDING";
        this.poolSeals = {};
        this.tricksPlayed = 0;
        this.startingPlayerOffset = 0;
        this.currentPlayerIdx = 0;
    }

    reset() {
        // Create and shuffle deck
        const cards = [];
        for (let c = 0; c < NUM_COLORS; c++) {
            for (let v = 1; v <= CARDS_PER_COLOR; v++) {
                cards.push(new Card(c, v));
            }
        }
        this.shuffleArray(cards);

        // Deal cards
        for (let i = 0; i < NUM_PLAYERS; i++) {
            this.players[i].reset();
            this.players[i].hand = cards.slice(i * 15, (i + 1) * 15);
            this.players[i].hand.sort((a, b) => a.id - b.id);
        }

        this.roundHistoryMask.fill(0);
        this.currentTrick = [];
        this.phase = "BIDDING";
        this.tricksPlayed = 0;
        this.poolSeals = { 0: 5, 1: 3, 2: 3, 3: 3, 4: 3 };
        this.currentPlayerIdx = this.startingPlayerOffset % NUM_PLAYERS;

        return this.getState(this.currentPlayerIdx);
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    step(action) {
        const player = this.players[this.currentPlayerIdx];
        let reward = 0.0;
        let done = false;
        const info = { rewards: { 0: 0.0, 1: 0.0, 2: 0.0 } };

        if (this.phase === "BIDDING") {
            if (action < 5) {
                if (this.poolSeals[action] > 0) {
                    this.poolSeals[action]--;
                    player.seals[action]++;
                    player.initialSeals[action]++;
                }
            } else if (action === 5) {
                player.hasPassedBidding = true;
                this._advanceBiddingTurn();
            }
        } else if (this.phase === "PLAYING") {
            const cardId = action - 6;
            const cardToPlay = player.hand.find(c => c.id === cardId);

            if (cardToPlay) {
                player.hand = player.hand.filter(c => c.id !== cardId);
                player.playedCardsMask[cardId] = 1;
                this.currentTrick.push({ playerIdx: this.currentPlayerIdx, card: cardToPlay });
                this.roundHistoryMask[cardId] = 1;

                if (this.currentTrick.length < NUM_PLAYERS) {
                    this.currentPlayerIdx = (this.currentPlayerIdx + 1) % NUM_PLAYERS;
                } else {
                    const leadColor = this.currentTrick[0].card.color;
                    const { winnerIdx, winCard } = this._resolveTrick();
                    const stepReward = this._assignTrickResult(winnerIdx, winCard, leadColor);
                    info.rewards[winnerIdx] = stepReward;
                    reward = info.rewards[this.currentPlayerIdx];

                    this.currentTrick = [];
                    this.tricksPlayed++;

                    if (this.tricksPlayed === TRICKS_PER_ROUND) {
                        done = true;
                        info.scores = this._calculateScores();
                    } else {
                        this.currentPlayerIdx = winnerIdx;
                    }
                }
            }
        }

        return { state: this.getState(this.currentPlayerIdx), reward, done, info };
    }

    _advanceBiddingTurn() {
        if (this.players.every(p => p.hasPassedBidding)) {
            this.phase = "PLAYING";
            this.currentPlayerIdx = this.startingPlayerOffset % NUM_PLAYERS;
        } else {
            this.currentPlayerIdx = (this.currentPlayerIdx + 1) % NUM_PLAYERS;
            while (this.players[this.currentPlayerIdx].hasPassedBidding) {
                this.currentPlayerIdx = (this.currentPlayerIdx + 1) % NUM_PLAYERS;
            }
        }
    }

    _resolveTrick() {
        const leadCard = this.currentTrick[0].card;
        const leadSuit = leadCard.color;
        let bestCard = leadCard;
        let winnerIdx = this.currentTrick[0].playerIdx;

        for (let i = 1; i < this.currentTrick.length; i++) {
            const { playerIdx, card } = this.currentTrick[i];
            if (card.color === COLOR_RED) {
                if (bestCard.color !== COLOR_RED || card.value > bestCard.value) {
                    bestCard = card;
                    winnerIdx = playerIdx;
                }
            } else if (card.color === leadSuit && bestCard.color !== COLOR_RED) {
                if (card.value > bestCard.value) {
                    bestCard = card;
                    winnerIdx = playerIdx;
                }
            }
        }
        return { winnerIdx, winCard: bestCard };
    }

    _assignTrickResult(winnerIdx, winCard, leadColor) {
        const p = this.players[winnerIdx];

        // 1. If winning with RED (Trump), check LEAD color first
        if (winCard.color === COLOR_RED) {
            // First priority: Remove seal of the LEAD color (if player has it)
            if (p.seals[leadColor] > 0) {
                p.seals[leadColor]--;
                return 2.0;
            }
            // Second priority: Remove RED seal
            if (p.seals[COLOR_RED] > 0) {
                p.seals[COLOR_RED]--;
                return 2.0;
            }
        }
        // 2. Normal case (Non-Red win OR Red win but no relevant seals found above)
        // Check if we can remove the seal of the winning card's color
        // (Note: If Red win fell through above, this check covers Red seal again, which is redundant but safe)
        else if (p.seals[winCard.color] > 0) {
            p.seals[winCard.color]--;
            return 2.0;
        }

        // 3. Penalty
        p.blackSeals++;
        return -3.0;
    }

    _calculateScores() {
        return this.players.map(p => {
            const leftoverSeals = Object.values(p.seals).reduce((a, b) => a + b, 0);
            return -(leftoverSeals * 2 + p.blackSeals * 3);
        });
    }

    getLegalActions(playerIdx) {
        const mask = new Array(51).fill(0);

        if (this.phase === "BIDDING") {
            for (let c = 0; c < 5; c++) {
                if (this.poolSeals[c] > 0) mask[c] = 1;
            }
            mask[5] = 1; // Pass
        } else {
            const p = this.players[playerIdx];
            if (this.currentTrick.length === 0) {
                for (const c of p.hand) {
                    mask[c.id + 6] = 1;
                }
            } else {
                const leadColor = this.currentTrick[0].card.color;
                const hasSuit = p.hand.some(c => c.color === leadColor);
                for (const c of p.hand) {
                    if (!hasSuit || c.color === leadColor) {
                        mask[c.id + 6] = 1;
                    }
                }
            }
        }
        return mask;
    }

    getState(pIdx) {
        const s = [];
        const relIndices = [0, 1, 2].map(i => (pIdx + i) % NUM_PLAYERS);
        const me = this.players[pIdx];

        // 1. Own Hand (45)
        const handVec = new Array(45).fill(0);
        for (const c of me.hand) handVec[c.id] = 1;
        s.push(...handVec);

        // 2. Pool (5)
        for (let c = 0; c < 5; c++) s.push(this.poolSeals[c] / 5.0);

        // 3. Rotated Current Bids (15)
        for (const idx of relIndices) {
            for (let c = 0; c < 5; c++) s.push(this.players[idx].seals[c] / 5.0);
        }

        // 4. Rotated Initial Bids (15)
        for (const idx of relIndices) {
            for (let c = 0; c < 5; c++) s.push(this.players[idx].initialSeals[c] / 5.0);
        }

        // 5. Rotated Black Seals (3)
        for (const idx of relIndices) s.push(this.players[idx].blackSeals / 15.0);

        // 6. Global Round History (45)
        s.push(...this.roundHistoryMask);

        // 7. Current Trick Ego-Centric (135)
        const trickMatrix = Array(3).fill(null).map(() => new Array(45).fill(0));
        for (const { playerIdx, card } of this.currentTrick) {
            const relPos = (playerIdx - pIdx + NUM_PLAYERS) % NUM_PLAYERS;
            trickMatrix[relPos][card.id] = 1;
        }
        s.push(...trickMatrix.flat());

        // 8. Phase Context (2)
        s.push(this.phase === "BIDDING" ? 1 : 0, this.phase === "PLAYING" ? 1 : 0);

        // 9. Turn Rank (3)
        const rank = [0, 0, 0];
        rank[this.currentTrick.length] = 1;
        s.push(...rank);

        // 10. Opponent Played Masks (90)
        for (let i = 1; i < 3; i++) {
            const opp = this.players[(pIdx + i) % NUM_PLAYERS];
            s.push(...opp.playedCardsMask);
        }

        // 11. Hand Counts & Progress (6)
        const hc = [0, 0, 0, 0, 0];
        for (const c of me.hand) hc[c.color]++;
        for (let i = 0; i < 5; i++) s.push(hc[i] / 15.0);
        s.push(this.tricksPlayed / 15.0);

        return new Float32Array(s);
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { WizardExtremeGame, Card, Player, NUM_PLAYERS, NUM_COLORS, COLOR_NAMES, TOTAL_CARDS };
}
