CREATE TABLE IF NOT EXISTS ranked_players (
    identity text PRIMARY KEY CHECK (identity ~ '^[a-f0-9]{64}$'),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 16),
    country text NOT NULL CHECK (country ~ '^([A-Z]{2})?$'),
    best bigint NOT NULL DEFAULT 0 CHECK (best >= 0),
    total bigint NOT NULL DEFAULT 0 CHECK (total >= 0),
    seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ranked_runs (
    run_id text PRIMARY KEY CHECK (run_id ~ '^[a-f0-9]{32}$'),
    player text NOT NULL REFERENCES ranked_players(identity),
    best bigint NOT NULL CHECK (best >= 0),
    collected bigint NOT NULL CHECK (collected >= 0)
);

CREATE INDEX IF NOT EXISTS ranked_players_best ON ranked_players (best DESC, identity);
CREATE INDEX IF NOT EXISTS ranked_players_total ON ranked_players (total DESC, identity);

CREATE OR REPLACE FUNCTION add_ranked_run_delta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE ranked_players
    SET best = greatest(best, NEW.best),
        total = total + NEW.collected - CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE OLD.collected END
    WHERE identity = NEW.player;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER ranked_run_delta
AFTER INSERT OR UPDATE ON ranked_runs FOR EACH ROW
EXECUTE FUNCTION add_ranked_run_delta();
