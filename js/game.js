// Wizard Extreme Game Engine - JavaScript Port
// Ported from Python game_engine.py (v2 - with Joker Seals and Decision Step)

const NUM_PLAYERS = 3;
const NUM_COLORS = 5;
const CARDS_PER_COLOR = 9;
const TOTAL_CARDS = 45;
const TRICKS_PER_ROUND = 15;

const COLOR_RED = 0; // Trump
const COLOR_NAMES = { 0: "Red", 1: "Blue", 2: "Yellow", 3: "Green", 4: "Purple" };

// Action Space: 67
// 0-4: Bid Color
// 5: Pass
// 6-15: Steal (Col 0..4 from P+1, P+2)
// 16-60: Play Card (Cards 0..44)
// 61-65: Discard Seal (Col 0..4)
// 66: Use Joker
const ACTION_SPACE_SIZE = 67;
const STATE_DIM = 373;

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
        this.jokerSeals = 0; // White Joker Seals
        this.blackSeals = 0;
        this.hasPassedBidding = false;
        this.playedCardsMask = new Array(TOTAL_CARDS).fill(0);
    }

    reset() {
        this.hand = [];
        this.seals = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
        this.initialSeals = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
        this.jokerSeals = 0;
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
        this.phase = "BIDDING"; // BIDDING, PLAYING, DISCARDING
        this.poolSeals = {};
        this.jokerPool = 4; // Maximum jokers that can be given during stealing
        this.tricksPlayed = 0;
        this.startingPlayerOffset = 0;
        this.currentPlayerIdx = 0;

        // State for Discard Phase handling
        this.pendingTrickWinner = null;
        this.pendingLeadColor = null;
        this.pendingWinCard = null;
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
        this.jokerPool = 4; // Reset joker pool
        this.currentPlayerIdx = this.startingPlayerOffset % NUM_PLAYERS;

        this.pendingTrickWinner = null;
        this.pendingLeadColor = null;
        this.pendingWinCard = null;

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
                // Take Seal
                if (this.poolSeals[action] > 0) {
                    this.poolSeals[action]--;
                    player.seals[action]++;
                    player.initialSeals[action]++;
                }
            } else if (action === 5) {
                // Pass
                player.hasPassedBidding = true;
                this._advanceBiddingTurn();
            } else if (action >= 6 && action <= 15) {
                // Stealing
                const stealIdx = action - 6;
                const color = Math.floor(stealIdx / 2);
                const targetRel = (stealIdx % 2) + 1; // 1 or 2
                const targetAbs = (this.currentPlayerIdx + targetRel) % NUM_PLAYERS;
                const targetPlayer = this.players[targetAbs];

                if (targetPlayer.seals[color] > 0) {
                    targetPlayer.seals[color]--;
                    player.seals[color]++;
                    player.initialSeals[color]++;
                    // Victim gets Joker (if pool has remaining)
                    if (this.jokerPool > 0) {
                        targetPlayer.jokerSeals++;
                        this.jokerPool--;
                    }
                }
            }
        } else if (this.phase === "PLAYING") {
            if (action >= 16 && action <= 60) {
                const cardId = action - 16;
                const cardToPlay = player.hand.find(c => c.id === cardId);

                if (cardToPlay) {
                    player.hand = player.hand.filter(c => c.id !== cardId);
                    player.playedCardsMask[cardId] = 1;
                    this.currentTrick.push({ playerIdx: this.currentPlayerIdx, card: cardToPlay });
                    this.roundHistoryMask[cardId] = 1;

                    if (this.currentTrick.length < NUM_PLAYERS) {
                        this.currentPlayerIdx = (this.currentPlayerIdx + 1) % NUM_PLAYERS;
                    } else {
                        // Trick complete, resolve winner
                        const leadColor = this.currentTrick[0].card.color;
                        const { winnerIdx, winCard } = this._resolveTrick();

                        // Check for Decision State
                        const decisionNeeded = this._checkDecisionNeeded(winnerIdx, winCard, leadColor);

                        if (decisionNeeded) {
                            this.pendingTrickWinner = winnerIdx;
                            this.pendingLeadColor = leadColor;
                            this.pendingWinCard = winCard;
                            this.phase = "DISCARDING";
                            this.currentPlayerIdx = winnerIdx; // Winner decides
                        } else {
                            // Auto-resolve
                            const stepReward = this._assignTrickResultAuto(winnerIdx, winCard, leadColor);
                            info.rewards[winnerIdx] = stepReward;
                            reward = info.rewards[this.currentPlayerIdx];
                            this._finalizeTrick(winnerIdx);
                        }
                    }
                }
            }
        } else if (this.phase === "DISCARDING") {
            // Actions 61-66
            const winner = this.players[this.currentPlayerIdx];

            let discardColor = -1;
            let useJoker = false;

            if (action >= 61 && action <= 65) {
                discardColor = action - 61;
            } else if (action === 66) {
                useJoker = true;
            }

            let stepReward = 0.0;
            let validDecision = false;

            if (useJoker) {
                if (winner.jokerSeals > 0) {
                    winner.jokerSeals--;
                    stepReward = 2.0;
                    validDecision = true;
                }
            } else if (discardColor !== -1) {
                if (winner.seals[discardColor] > 0) {
                    // Check validity based on Trick Type
                    if (this.pendingWinCard.color === COLOR_RED) {
                        // Red Win: Must be Red or Lead
                        if (discardColor === COLOR_RED || discardColor === this.pendingLeadColor) {
                            winner.seals[discardColor]--;
                            stepReward = 2.0;
                            validDecision = true;
                        }
                    } else {
                        // Standard Win: Must be Win Color
                        if (discardColor === this.pendingWinCard.color) {
                            winner.seals[discardColor]--;
                            stepReward = 2.0;
                            validDecision = true;
                        }
                    }
                }
            }

            if (!validDecision) {
                // Penalty
                winner.blackSeals++;
                stepReward = -3.0;
            }

            info.rewards[this.currentPlayerIdx] = stepReward;
            reward = stepReward;
            this._finalizeTrick(this.currentPlayerIdx);
        }

        // Check Done (Round End)
        if (this.tricksPlayed === TRICKS_PER_ROUND && this.currentTrick.length === 0) {
            done = true;
            info.scores = this._calculateScores();
        }

        return { state: this.getState(this.currentPlayerIdx), reward, done, info };
    }

    _finalizeTrick(winnerIdx) {
        this.currentTrick = [];
        this.tricksPlayed++;
        this.phase = "PLAYING";
        this.pendingTrickWinner = null;
        this.pendingLeadColor = null;
        this.pendingWinCard = null;
        this.currentPlayerIdx = winnerIdx;
    }

    _checkDecisionNeeded(winnerIdx, winCard, leadColor) {
        const p = this.players[winnerIdx];
        const hasJokers = p.jokerSeals > 0;

        // Red Win with Choice
        const isRedWin = (winCard.color === COLOR_RED);
        const hasRedSeal = p.seals[COLOR_RED] > 0;
        const hasLeadSeal = p.seals[leadColor] > 0;

        const redChoice = isRedWin && hasRedSeal && hasLeadSeal;

        if (hasJokers) return true;
        if (redChoice) return true;

        return false;
    }

    _assignTrickResultAuto(winnerIdx, winCard, leadColor) {
        const p = this.players[winnerIdx];

        // Red Win (Single Option Priority)
        if (winCard.color === COLOR_RED) {
            if (p.seals[leadColor] > 0) {
                p.seals[leadColor]--;
                return 2.0;
            }
            if (p.seals[COLOR_RED] > 0) {
                p.seals[COLOR_RED]--;
                return 2.0;
            }
        } else {
            // Standard Win
            if (p.seals[winCard.color] > 0) {
                p.seals[winCard.color]--;
                return 2.0;
            }
        }

        // Penalty
        p.blackSeals++;
        return -3.0;
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

    _calculateScores() {
        // -3 per remaining seal, -3 per black seal, -4 per joker seal
        return this.players.map(p => {
            const leftoverSeals = Object.values(p.seals).reduce((a, b) => a + b, 0);
            return -(leftoverSeals * 3 + p.blackSeals * 3 + p.jokerSeals * 4);
        });
    }

    getLegalActions(playerIdx) {
        const mask = new Array(ACTION_SPACE_SIZE).fill(0);
        const p = this.players[playerIdx];

        if (this.phase === "BIDDING") {
            // 0-4: Take Seal (if pool > 0)
            for (let c = 0; c < 5; c++) {
                if (this.poolSeals[c] > 0) mask[c] = 1;
            }

            // 5: Pass (always legal)
            mask[5] = 1;

            // 6-15: Steal (if pool == 0 AND target has seal)
            for (let color = 0; color < 5; color++) {
                if (this.poolSeals[color] === 0) {
                    for (let i = 1; i <= 2; i++) {
                        const targetIdx = (playerIdx + i) % NUM_PLAYERS;
                        if (this.players[targetIdx].seals[color] > 0) {
                            const actionIdx = 6 + (color * 2) + (i - 1);
                            mask[actionIdx] = 1;
                        }
                    }
                }
            }
        } else if (this.phase === "PLAYING") {
            if (this.currentTrick.length === 0) {
                for (const c of p.hand) {
                    mask[c.id + 16] = 1;
                }
            } else {
                const leadColor = this.currentTrick[0].card.color;
                const hasSuit = p.hand.some(c => c.color === leadColor);
                for (const c of p.hand) {
                    if (!hasSuit || c.color === leadColor) {
                        mask[c.id + 16] = 1;
                    }
                }
            }
        } else if (this.phase === "DISCARDING") {
            // Only current player (Winner) acts
            if (playerIdx === this.currentPlayerIdx) {
                const hasJokers = p.jokerSeals > 0;

                // 66: Use Joker
                if (hasJokers) mask[66] = 1;

                // 61-65: Discard Colors
                const winCardColor = this.pendingWinCard.color;
                const leadColor = this.pendingLeadColor;

                if (winCardColor === COLOR_RED) {
                    // Can discard Red or Lead
                    if (p.seals[COLOR_RED] > 0) mask[61 + COLOR_RED] = 1;
                    if (p.seals[leadColor] > 0) mask[61 + leadColor] = 1;
                } else {
                    // Can discard Win Color
                    if (p.seals[winCardColor] > 0) mask[61 + winCardColor] = 1;
                }
            }
        }
        return mask;
    }

    getState(pIdx) {
        // Generates 373-dim ego-centric state
        const s = [];
        const relIndices = [0, 1, 2].map(i => (pIdx + i) % NUM_PLAYERS);
        const me = this.players[pIdx];

        // 1. Own Hand (45)
        const handVec = new Array(45).fill(0);
        for (const c of me.hand) handVec[c.id] = 1;
        s.push(...handVec);

        // 2. Pool (5)
        for (let c = 0; c < 5; c++) s.push(this.poolSeals[c] / 5.0);

        // 3. Rotated Bids (18) -> (5 Seals + 1 Joker) * 3
        for (const idx of relIndices) {
            const pObj = this.players[idx];
            for (let c = 0; c < 5; c++) s.push(pObj.seals[c] / 5.0);
            s.push(pObj.jokerSeals / 5.0);
        }

        // 4. Rotated History (18) -> (5 Init + 1 Black) * 3
        for (const idx of relIndices) {
            const pObj = this.players[idx];
            for (let c = 0; c < 5; c++) s.push(pObj.initialSeals[c] / 5.0);
            s.push(pObj.blackSeals / 5.0);
        }

        // 5. Global History (45)
        s.push(...this.roundHistoryMask);

        // 6. Trick Matrix (135)
        const trickMatrix = Array(3).fill(null).map(() => new Array(45).fill(0));
        for (const { playerIdx, card } of this.currentTrick) {
            const relPos = (playerIdx - pIdx + NUM_PLAYERS) % NUM_PLAYERS;
            trickMatrix[relPos][card.id] = 1;
        }
        s.push(...trickMatrix.flat());

        // 7. Context (17)
        // Phase One-Hot (3): Bidding, Playing, Discarding
        if (this.phase === "BIDDING") s.push(1, 0, 0);
        else if (this.phase === "PLAYING") s.push(0, 1, 0);
        else s.push(0, 0, 1);

        // Turn Rank (3)
        const rank = [0, 0, 0];
        if (this.currentTrick.length < 3) {
            rank[this.currentTrick.length] = 1;
        }
        s.push(...rank);

        // Hand Counts (5)
        const hc = [0, 0, 0, 0, 0];
        for (const c of me.hand) hc[c.color]++;
        for (let i = 0; i < 5; i++) s.push(hc[i] / 15.0);

        // Tricks Played (1)
        s.push(this.tricksPlayed / 15.0);

        // Discard Context (5) - Pending Win Color if DISCARDING
        const dc = [0, 0, 0, 0, 0];
        if (this.phase === "DISCARDING" && this.pendingWinCard) {
            dc[this.pendingWinCard.color] = 1;
        }
        s.push(...dc);

        // 8. Memory (90) - Played Cards by Opp1 (45) and Opp2 (45)
        for (let i = 1; i <= 2; i++) {
            const opp = this.players[(pIdx + i) % NUM_PLAYERS];
            s.push(...opp.playedCardsMask);
        }

        return new Float32Array(s);
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { WizardExtremeGame, Card, Player, NUM_PLAYERS, NUM_COLORS, COLOR_NAMES, TOTAL_CARDS, ACTION_SPACE_SIZE, STATE_DIM };
}
