-- Page store schema. Apply with `npm run migrate` (see imright/scripts/migrate.js),
-- or paste directly into Railway's Postgres query console / `psql $DATABASE_URL`.

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,                          -- pageId, e.g. "birds-arent-real-4401c811"
  claim TEXT NOT NULL,
  topic TEXT,
  article JSONB NOT NULL,                       -- { headline, intro, sections, conclusion, paragraphs }
  citations JSONB NOT NULL DEFAULT '[]',
  images JSONB NOT NULL DEFAULT '{}',           -- { hero: url, "section-0": url, ... } — hotlinked, not stored
  counterarguments JSONB,                       -- null until step 7 finishes
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
