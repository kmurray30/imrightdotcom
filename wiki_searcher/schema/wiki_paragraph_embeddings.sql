-- One-time setup on the existing Postgres (Railway: attached Postgres ->
-- Data tab -> Query, or `psql "$DATABASE_URL"`).
--
-- vector(384) must match wiki_searcher/textEmbeddings.js's EMBEDDING_DIMENSIONS. If the
-- embedding model ever changes, this table needs to be dropped and rebuilt
-- from scratch (see wiki_searcher/scripts/build-index-from-wikimedia.js) —
-- vectors from different models aren't comparable.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS wiki_paragraph_embeddings (
  id                 BIGSERIAL PRIMARY KEY,
  title              TEXT NOT NULL,        -- the join key search actually uses (see providers/wikimedia.js) — the On-demand API only supports title-based lookup, no ID-based fetch endpoint exists
  page_id            BIGINT,               -- Wikimedia's article.identifier — a stable per-page ID that survives renames, title can't. Not usable to fetch content (see above), but used to detect and clean up a since-renamed title's stale rows (see embeddingIndex.js's upsertArticleEmbeddings)
  paragraph_index    INT NOT NULL,
  section            TEXT NOT NULL,        -- section this paragraph came from; also folded into the embedded text (see embeddingIndex.js)
  paragraph_text     TEXT NOT NULL,        -- cleaned (markup/ref-stripped), unprefixed — the embedding prefix is search-time only, not stored
  embedding          vector(384) NOT NULL,
  version_identifier BIGINT,               -- Wikimedia's version.identifier; matched on re-run to skip already-current articles
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (title, paragraph_index)
);

-- ADD COLUMN, not just part of CREATE TABLE above, so re-running this file
-- against a database that already has the table (pre-dating page_id) picks
-- it up too, instead of silently no-op'ing on the CREATE TABLE IF NOT EXISTS.
ALTER TABLE wiki_paragraph_embeddings ADD COLUMN IF NOT EXISTS page_id BIGINT;

CREATE INDEX IF NOT EXISTS wiki_paragraph_embeddings_page_id
  ON wiki_paragraph_embeddings (page_id);

-- Disk-backed ANN index (not held fully in RAM) — see the cost/latency
-- discussion this schema came out of. ivfflat is a reasonable default;
-- switch to hnsw if pgvector's version on Railway's Postgres supports it
-- and query latency needs to improve further.
CREATE INDEX IF NOT EXISTS wiki_paragraph_embeddings_ann
  ON wiki_paragraph_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 200);

CREATE INDEX IF NOT EXISTS wiki_paragraph_embeddings_title
  ON wiki_paragraph_embeddings (title);
