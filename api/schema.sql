-- Wizard Extreme online multiplayer schema (Neon Postgres).
-- Apply once:  psql "$DATABASE_URL" -f api/schema.sql
-- gen_random_uuid() is built in on Neon (pg14+).

CREATE TABLE IF NOT EXISTS players (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nickname   TEXT NOT NULL,
    token      TEXT NOT NULL,                 -- per-session secret, never sent to other players
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status         TEXT NOT NULL DEFAULT 'playing',   -- 'playing' | 'done'
    state          JSONB NOT NULL,                    -- serialize(game) blob (pimc_core contract)
    seats          JSONB NOT NULL,                    -- [{type:'human'|'ai', player_id?, model?, pimc?}] x3
    current_seat   INT  NOT NULL DEFAULT 0,
    match_round    INT  NOT NULL DEFAULT 0,           -- 0..2 (best of 3 rounds, like single-player)
    total_scores   JSONB NOT NULL DEFAULT '[0,0,0]',  -- cumulative per absolute seat
    last_round_scores JSONB,                           -- most recently completed round's per-seat scores
    version        INT  NOT NULL DEFAULT 0,           -- bumped every applied move; cheap poll diffing
    last_action_at TIMESTAMPTZ NOT NULL DEFAULT now(),-- for idle/disconnect turn-timeout
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS queue (
    id        BIGSERIAL PRIMARY KEY,
    player_id UUID NOT NULL REFERENCES players(id),
    nickname  TEXT NOT NULL,
    status    TEXT NOT NULL DEFAULT 'waiting',        -- 'waiting' | 'matched'
    game_id   UUID REFERENCES games(id),
    seat      INT,                                    -- absolute seat once matched
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active queue row per player; supports the SKIP LOCKED grab in join/fill.
CREATE INDEX IF NOT EXISTS queue_waiting_idx ON queue (joined_at) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS queue_player_idx  ON queue (player_id);
