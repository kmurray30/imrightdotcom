-- Tracks the last successful refresh-daily.js run, so a missed/failed run
-- (Railway downtime, a crash mid-run) doesn't create a permanent gap the
-- next run can't see past — see wiki_searcher/scripts/refresh-daily.js.
--
-- Single-row table: id is always TRUE, enforced by the check constraint,
-- so there's exactly one checkpoint ever.

CREATE TABLE IF NOT EXISTS wiki_refresh_checkpoint (
  id             BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  last_synced_at TIMESTAMPTZ NOT NULL
);
