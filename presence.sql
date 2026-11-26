CREATE TABLE IF NOT EXISTS online_presence (
    instance text PRIMARY KEY,
    players integer NOT NULL CHECK (players BETWEEN 0 AND 48),
    expires_at timestamptz NOT NULL
);
