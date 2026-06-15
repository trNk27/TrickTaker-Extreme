import numpy as np
import random

# Constants
NUM_PLAYERS = 3
NUM_COLORS = 5
CARDS_PER_COLOR = 9
TOTAL_CARDS = 45 # 5 * 9
TRICKS_PER_ROUND = 15

# Action Space: 67
# 0-4: Bid Color
# 5: Pass
# 6-15: Steal (Col 0..4 from P+1, P+2)
# 16-60: Play Card (Cards 0..44)
# 61-65: Discard Seal (Col 0..4)
# 66: Use Joker

ACTION_SPACE_SIZE = 67
STATE_DIM = 373

# --- STEP REWARD SIGNALS (shaping; see src/signals.md) ---
# Small on purpose: the final score in _calculate_scores() carries the real
# objective. Rebalanced down from +2.0/-1.5/0.0 because the old values made
# bidding look too profitable and the learner over-bid.
REWARD_TAKE_SEAL = -0.5       # (legacy) flat per-seal cost; superseded by the
                              # progressive over-bid penalty below
REWARD_SEAL_FULFILLED = 0.5   # won a trick and discarded a matching seal/joker
REWARD_BLACK_SEAL = -0.5      # won a trick with no matching seal -> black seal

# --- OVER-BIDDING PENALTY (permanent; NOT annealed by the trainer) ---
# 15 tricks / 3 players = 5 expected tricks each, so 5 seals is the neutral bid.
# Seals 1..BID_SOFT_CAP are free; each seal beyond the cap carries an escalating
# penalty (6th: -0.5, 7th: -1.0, 8th: -1.5, ...). It is a gradient, not a hard
# wall, so a genuinely strong hand can still "pay" to bid above 5.
BID_SOFT_CAP = 5
REWARD_OVERBID_STEP = 0.0     # DISABLED. Set negative (e.g. -0.5) to penalise the
                             # nth seal above the cap = step*(n-cap). A clean fresh
                             # run learns ~5-seal discipline from the score alone
                             # (Casio2 reached bid 5.2 with no penalty); the penalty
                             # only mattered for resume/cold-optimizer overbidding.

COLOR_RED = 0    # Trump
COLOR_BLUE = 1
COLOR_YELLOW = 2
COLOR_GREEN = 3
COLOR_PURPLE = 4

COLOR_NAMES = {0: "Red", 1: "Blue", 2: "Yellow", 3: "Green", 4: "Purple"}

class Card:
    def __init__(self, color, value):
        self.color = color
        self.value = value 
        self.id = color * CARDS_PER_COLOR + (value - 1)

class Player:
    def __init__(self, player_id):
        self.id = player_id
        self.hand = []
        self.seals = {0:0, 1:0, 2:0, 3:0, 4:0} # Standard color seals
        self.initial_seals = {0:0, 1:0, 2:0, 3:0, 4:0}
        self.joker_seals = 0 # White Joker Seals
        self.black_seals = 0
        self.has_passed_bidding = False
        self.played_cards_mask = np.zeros(TOTAL_CARDS, dtype=int)
    
    def reset(self):
        self.hand = []
        self.seals = {0:0, 1:0, 2:0, 3:0, 4:0}
        self.initial_seals = {0:0, 1:0, 2:0, 3:0, 4:0}
        self.joker_seals = 0
        self.black_seals = 0
        self.has_passed_bidding = False
        self.played_cards_mask.fill(0)

class WizardExtremeGame:
    def __init__(self):
        self.players = [Player(i) for i in range(NUM_PLAYERS)]
        self.round_history_mask = np.zeros(TOTAL_CARDS, dtype=int)
        self.current_trick = [] # Stores (player_idx, Card)
        self.phase = "BIDDING" # BIDDING, PLAYING, DISCARDING
        self.pool_seals = {}
        self.joker_pool = 4  # Maximum jokers that can be given during stealing
        self.tricks_played = 0
        self.starting_player_offset = 0 
        self.current_player_idx = 0
        
        # State for Discard Phase handling
        self.pending_trick_winner = None
        self.pending_trick_result_type = None # "RED_WIN", "JOKER_WIN"
        self.pending_lead_color = None
        self.pending_win_card = None

        # Most recently completed trick, for the online client's 2s reveal:
        # {"cards": [[seat, cardId] x3], "winner": seat}. Server-only; PIMC ignores it.
        self.last_completed_trick = None

    def reset(self):
        cards = []
        for c in range(NUM_COLORS):
            for v in range(1, CARDS_PER_COLOR + 1):
                cards.append(Card(c, v))
        random.shuffle(cards)
        
        for i, p in enumerate(self.players):
            p.reset()
            p.hand = sorted(cards[i*15 : (i+1)*15], key=lambda x: x.id)
        
        self.round_history_mask.fill(0)
        self.current_trick = []
        self.phase = "BIDDING"
        self.tricks_played = 0
        self.pool_seals = {0: 5, 1: 3, 2: 3, 3: 3, 4: 3}
        self.joker_pool = 4  # Reset joker pool
        
        self.current_player_idx = self.starting_player_offset % NUM_PLAYERS
        
        self.pending_trick_winner = None
        self.pending_trick_result_type = None
        
        return self.get_state(self.current_player_idx)

    def step(self, action):
        player = self.players[self.current_player_idx]
        reward = 0.0
        done = False
        # 'rewards' = annealed step-shaping (scaled by the trainer's shaping_coef).
        # 'permanent_rewards' = structural signals the trainer never anneals.
        info = {'rewards': {0: 0.0, 1: 0.0, 2: 0.0},
                'permanent_rewards': {0: 0.0, 1: 0.0, 2: 0.0}}

        if self.phase == "BIDDING":
            if action < 5: # Take Seal
                if self.pool_seals[action] > 0:
                    self.pool_seals[action] -= 1
                    player.seals[action] += 1
                    player.initial_seals[action] += 1
                    # Seals 1..BID_SOFT_CAP are free; over-bidding is penalised
                    # permanently and progressively. Routed through info (the
                    # scalar return alone is ignored by the trainer's crediting).
                    n = sum(player.initial_seals.values())
                    if n > BID_SOFT_CAP:
                        penalty = REWARD_OVERBID_STEP * (n - BID_SOFT_CAP)
                        reward = penalty
                        info['permanent_rewards'][self.current_player_idx] = penalty
            elif action == 5: # Pass
                player.has_passed_bidding = True
                self._advance_bidding_turn()
            elif 6 <= action <= 15: # Stealing
                # Map 6-15 to (Color, TargetRelIdx)
                # 6: Col 0, P+1; 7: Col 0, P+2
                # 8: Col 1, P+1; 9: Col 1, P+2...
                steal_idx = action - 6
                color = steal_idx // 2
                target_rel = (steal_idx % 2) + 1 # 1 or 2
                target_abs = (self.current_player_idx + target_rel) % NUM_PLAYERS
                target_player = self.players[target_abs]
                
                # Validation handled in get_legal_actions, assume valid here
                if target_player.seals[color] > 0:
                    target_player.seals[color] -= 1
                    player.seals[color] += 1
                    player.initial_seals[color] += 1 # Count as initial bid? Rules unclear, assume yes for tracking logic
                    # Victim gets Joker (if pool has remaining)
                    if self.joker_pool > 0:
                        target_player.joker_seals += 1
                        self.joker_pool -= 1
            
        elif self.phase == "PLAYING":
            if 16 <= action <= 60:
                card_id = action - 16
                card_to_play = next((c for c in player.hand if c.id == card_id), None)
                
                if card_to_play:
                    player.hand.remove(card_to_play)
                    player.played_cards_mask[card_id] = 1
                    self.current_trick.append((self.current_player_idx, card_to_play))
                    self.round_history_mask[card_id] = 1
                    
                    if len(self.current_trick) < NUM_PLAYERS:
                        self.current_player_idx = (self.current_player_idx + 1) % NUM_PLAYERS
                    else:
                        # Trick complete, resolve winner
                        lead_color = self.current_trick[0][1].color
                        winner_idx, win_card = self._resolve_trick()

                        # Snapshot the just-completed 3-card trick so the online
                        # client can keep it on screen for ~2s before it clears.
                        self.last_completed_trick = {
                            "cards": [[pi, c.id] for pi, c in self.current_trick],
                            "winner": int(winner_idx),
                        }

                        # Check for Decision State
                        decision_needed = self._check_decision_needed(winner_idx, win_card, lead_color)
                        
                        if decision_needed:
                            self.pending_trick_winner = winner_idx
                            self.pending_lead_color = lead_color
                            self.pending_win_card = win_card
                            self.phase = "DISCARDING"
                            self.current_player_idx = winner_idx # Winner decides
                            # Return here to get decision from agent
                        else:
                            # Auto-resolve
                            step_reward = self._assign_trick_result_auto(winner_idx, win_card, lead_color)
                            info['rewards'][winner_idx] = step_reward
                            reward = info['rewards'][self.current_player_idx]
                            self._finalize_trick(winner_idx, done, info)

        elif self.phase == "DISCARDING":
            # Actions 61-66
            winner = self.players[self.current_player_idx] # Should be winner
            
            discard_color = -1
            use_joker = False
            
            if 61 <= action <= 65:
                discard_color = action - 61
            elif action == 66:
                use_joker = True
                
            step_reward = 0.0
            valid_decision = False
            
            # Helper to finalize decision
            if use_joker:
                if winner.joker_seals > 0:
                    winner.joker_seals -= 1
                    step_reward = REWARD_SEAL_FULFILLED
                    valid_decision = True
            elif discard_color != -1:
                # Can we discard this color?
                # Must be Red Seal OR Lead Color Seal (if Red Win)
                # Or simply matching seal (Standard Win)
                # Or any seal (Joker Win?? Rules say "Joker can be used to satisfy contract". Usually means 'counts as match'.
                # Actually Joker usage replaces the need to discard a specific color.
                # If we discard a color, we are NOT using a Joker explicitly as 'Wild', we are fulfilling a seal.
                # Standard Logic checks.
                
                if winner.seals[discard_color] > 0:
                     # Check validity based on Trick Type
                     # If Red Win: Must be Red or Lead.
                     if self.pending_win_card.color == COLOR_RED:
                         if discard_color == COLOR_RED or discard_color == self.pending_lead_color:
                             winner.seals[discard_color] -= 1
                             step_reward = REWARD_SEAL_FULFILLED
                             valid_decision = True
                     else:
                         # Standard Win: Must be Win Color
                         if discard_color == self.pending_win_card.color:
                             winner.seals[discard_color] -= 1
                             step_reward = REWARD_SEAL_FULFILLED
                             valid_decision = True

            if not valid_decision:
                # Fallback / Penalty if illegal choice (shouldn't happen with valid masking)
                # Or maybe default to Black Seal?
                # Let's give Black Seal and end trick
                winner.black_seals += 1
                step_reward = REWARD_BLACK_SEAL
            
            info['rewards'][self.current_player_idx] = step_reward
            reward = step_reward
            self._finalize_trick(self.current_player_idx, done, info) # Phase -> PLAYING
            
        # Check Done (Round End) was set in finalize_trick or similar?
        if self.tricks_played == TRICKS_PER_ROUND and self.current_trick == []:
            done = True
            info['scores'] = self._calculate_scores()

        return self.get_state(self.current_player_idx), reward, done, info

    def _finalize_trick(self, winner_idx, done, info):
        self.current_trick = []
        self.tricks_played += 1
        self.phase = "PLAYING"
        self.pending_trick_winner = None
        self.current_player_idx = winner_idx

    def _check_decision_needed(self, winner_idx, win_card, lead_color):
        p = self.players[winner_idx]
        has_jokers = p.joker_seals > 0
        
        # Red Win with Choice
        is_red_win = (win_card.color == COLOR_RED)
        has_red_seal = p.seals[COLOR_RED] > 0
        has_lead_seal = p.seals[lead_color] > 0
        
        red_choice = is_red_win and has_red_seal and has_lead_seal
        
        # Any win with Joker Option
        # Note: can always use Joker if you have one? Yes.
        # So if p has Joker, they ALWAYS have a choice (Use Joker OR Discard Color OR Take Penalty).
        # We want to give them the option.
        
        if has_jokers: return True
        if red_choice: return True
        
        return False

    def _assign_trick_result_auto(self, winner_idx, win_card, lead_color):
        # Called when NO decision interaction was needed (or possible)
        # e.g. No Jokers, and not a Red Win with multiple options.
        p = self.players[winner_idx]
        
        # 1. Red Win (Single Option Priority)
        if win_card.color == COLOR_RED:
            # Priority: Lead then Red (but we only come here if they don't have BOTH, 
            # otherwise it would be a decision. Or if they have only one, auto-use it?)
            # Actually, let's keep it simple: Auto-use best available if no Ambiguity.
            # If they have Lead: Use Lead.
            if p.seals[lead_color] > 0:
                p.seals[lead_color] -= 1
                return REWARD_SEAL_FULFILLED
            # If they have Red: Use Red.
            if p.seals[COLOR_RED] > 0:
                p.seals[COLOR_RED] -= 1
                return REWARD_SEAL_FULFILLED
        else:
            # 2. Standard Win
            if p.seals[win_card.color] > 0:
                p.seals[win_card.color] -= 1
                return REWARD_SEAL_FULFILLED
                
        # 3. Penalty
        p.black_seals += 1
        return REWARD_BLACK_SEAL

    def _advance_bidding_turn(self):
        if all(p.has_passed_bidding for p in self.players):
            self.phase = "PLAYING"
            self.current_player_idx = self.starting_player_offset % NUM_PLAYERS
        else:
            self.current_player_idx = (self.current_player_idx + 1) % NUM_PLAYERS
            while self.players[self.current_player_idx].has_passed_bidding:
                self.current_player_idx = (self.current_player_idx + 1) % NUM_PLAYERS

    def _resolve_trick(self):
        lead_card = self.current_trick[0][1]
        lead_suit = lead_card.color
        best_card, winner_idx = lead_card, self.current_trick[0][0]
        
        for p_idx, card in self.current_trick[1:]:
            if card.color == COLOR_RED: 
                if best_card.color != COLOR_RED or card.value > best_card.value:
                    best_card, winner_idx = card, p_idx
            elif card.color == lead_suit and best_card.color != COLOR_RED:
                if card.value > best_card.value:
                    best_card, winner_idx = card, p_idx
        return winner_idx, best_card

    def _calculate_scores(self):
        # -2 per seal, -3 per black seal, -4 per joker
        return [-(sum(p.seals.values())*2 + p.black_seals*3 + p.joker_seals*4) for p in self.players]

    def get_legal_actions(self, p_idx):
        mask = np.zeros(ACTION_SPACE_SIZE, dtype=int)
        p = self.players[p_idx]
        
        if self.phase == "BIDDING":
            # 0-4: Take Seal (if pool > 0)
            for c in range(5):
                if self.pool_seals[c] > 0: mask[c] = 1
            
            # 5: Pass (always legal)
            mask[5] = 1
            
            # 6-15: Steal (if pool == 0 AND target has seal)
            # 6: Col0 P+1, 7: Col0 P+2...
            for color in range(5):
                if self.pool_seals[color] == 0:
                    # Check Targets
                    for i in range(1, 3): # 1, 2
                        target_idx = (p_idx + i) % NUM_PLAYERS
                        if self.players[target_idx].seals[color] > 0:
                            action_idx = 6 + (color * 2) + (i - 1)
                            mask[action_idx] = 1
                            
        elif self.phase == "PLAYING":
            if not self.current_trick:
                for c in p.hand: mask[c.id + 16] = 1
            else:
                lead_color = self.current_trick[0][1].color
                has_suit = any(c.color == lead_color for c in p.hand)
                for c in p.hand:
                    if not has_suit or c.color == lead_color: mask[c.id + 16] = 1
                    
        elif self.phase == "DISCARDING":
            # Only current player (Winner) acts
            if p_idx == self.current_player_idx:
                has_jokers = p.joker_seals > 0
                
                # 66: Use Joker
                if has_jokers: mask[66] = 1
                
                # 61-65: Discard Colors
                # Rules depend on Red Win or Standard Win
                win_card_color = self.pending_win_card.color
                lead_color = self.pending_lead_color
                
                if win_card_color == COLOR_RED:
                    # Can discard Red (61) or Lead (61+lead)
                    if p.seals[COLOR_RED] > 0: mask[61 + COLOR_RED] = 1
                    if p.seals[lead_color] > 0: mask[61 + lead_color] = 1
                else:
                    # Can discard Win Color
                    if p.seals[win_card_color] > 0: mask[61 + win_card_color] = 1
                    
        return mask

    def get_state(self, p_idx):
        """Generates 373-dim ego-centric state."""
        s = []
        rel_indices = [(p_idx + i) % NUM_PLAYERS for i in range(NUM_PLAYERS)]
        me = self.players[p_idx]
        
        # 1. Own Hand (45)
        hv = np.zeros(45); [hv.__setitem__(c.id, 1) for c in me.hand]; s.extend(hv)
        
        # 2. Pool (5)
        for c in range(5): s.append(self.pool_seals[c] / 5.0)
        
        # 3. Rotated Bids (18) -> (5 Seals + 1 Joker) * 3
        for idx in rel_indices:
            p_obj = self.players[idx]
            for c in range(5): s.append(p_obj.seals[c] / 5.0)
            s.append(p_obj.joker_seals / 5.0) # Assume max 5 jokers logic?
            
        # 4. Rotated History (18) -> (5 Init + 1 Black) * 3
        for idx in rel_indices:
            p_obj = self.players[idx]
            for c in range(5): s.append(p_obj.initial_seals[c] / 5.0)
            s.append(p_obj.black_seals / 5.0) 
            
        # 5. Global History (45)
        s.extend(self.round_history_mask)
        
        # 6. Trick Matrix (135)
        trick_matrix = np.zeros((3, 45))
        for p_abs, card in self.current_trick:
            rel_pos = (p_abs - p_idx + NUM_PLAYERS) % NUM_PLAYERS
            trick_matrix[rel_pos][card.id] = 1
        s.extend(trick_matrix.flatten())
        
        # 7. Context (17)
        # Phase (3): Bidding, Playing, Discarding
        # Turn Rank (3)
        # Hand Counts (5 self) + Tricks Played (1) + ...?
        # Report says: "Phase flags, turn rank, hand counts, and discard context"
        
        # Phase One-Hot (3)
        if self.phase == "BIDDING": s.extend([1, 0, 0])
        elif self.phase == "PLAYING": s.extend([0, 1, 0])
        else: s.extend([0, 0, 1])
        
        # Turn Rank (3) - Guard for DISCARDING phase when trick is full
        rank = np.zeros(3)
        if len(self.current_trick) < 3:
            rank[len(self.current_trick)] = 1
        s.extend(rank)
        
        # Hand Counts (5) - My hand distribution
        hc = [0]*5; [hc.__setitem__(c.color, hc[c.color]+1) for c in me.hand]
        s.extend([x/15.0 for x in hc])
        
        # Tricks Played (1)
        s.append(self.tricks_played / 15.0)
        
        # Discard Context (5) - what color won, is it red win, etc?
        # Let's add: WinColor (OneHot 5)? Or just IsRedWin(1)?
        # Report says "17". We have 3+3+5+1 = 12 used. 5 remaining.
        # Let's put Pending Win Color (OneHot 5) if Phase==Discarding, else 0.
        dc = np.zeros(5)
        if self.phase == "DISCARDING" and self.pending_win_card:
            dc[self.pending_win_card.color] = 1
        s.extend(dc)
        
        # 8. Memory (90) - Played Cards by Opp1 (45) and Opp2 (45)
        for i in range(1, 3):
            opp = self.players[(p_idx + i) % NUM_PLAYERS]
            s.extend(opp.played_cards_mask)
            
        return np.array(s, dtype=np.float32)
