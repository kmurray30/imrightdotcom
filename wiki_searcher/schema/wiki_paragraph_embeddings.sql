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
  has_citation       BOOLEAN NOT NULL DEFAULT false, -- true if this specific paragraph sits next to a real citation (see embeddingIndex.js) — every paragraph is indexed regardless (recall), but search ranks cited ones first so a fixed top-N candidate budget goes to articles ref_extractor can actually pull a citation from before falling back to uncited-only matches (see utils/vectorIndex.js)
  version_identifier BIGINT,               -- Wikimedia's version.identifier; matched on re-run to skip already-current articles
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (title, paragraph_index)
);

-- ADD COLUMN, not just part of CREATE TABLE above, so re-running this file
-- against a database that already has the table (pre-dating page_id/
-- has_citation) picks them up too, instead of silently no-op'ing on the
-- CREATE TABLE IF NOT EXISTS.
ALTER TABLE wiki_paragraph_embeddings ADD COLUMN IF NOT EXISTS page_id BIGINT;
ALTER TABLE wiki_paragraph_embeddings ADD COLUMN IF NOT EXISTS has_citation BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS wiki_paragraph_embeddings_page_id
  ON wiki_paragraph_embeddings (page_id);

-- Superseded by the two partial indexes below — drop it if an earlier run
-- of this file already created it, so it's not left behind as dead weight.
DROP INDEX IF EXISTS wiki_paragraph_embeddings_ann;

-- Two partial ANN indexes, not one — a query that wants "nearest cited
-- paragraphs" can't efficiently get that from a single index over the whole
-- table: an ivfflat scan returns the overall nearest neighbors first, and a
-- WHERE has_citation=true filter applied after the fact would silently miss
-- genuinely-close cited matches whenever cited rows are a minority of
-- whatever the unfiltered scan happened to return. A partial index built
-- with the same WHERE clause the query uses doesn't have that problem —
-- confirmed via EXPLAIN against a real pgvector 0.6.0 instance that the
-- planner picks the matching partial index directly. See utils/vectorIndex.js
-- for the two-phase query (cited first, uncited fallback) that uses these.
CREATE INDEX IF NOT EXISTS wiki_paragraph_embeddings_ann_cited
  ON wiki_paragraph_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 200)
  WHERE has_citation = true;

CREATE INDEX IF NOT EXISTS wiki_paragraph_embeddings_ann_uncited
  ON wiki_paragraph_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 200)
  WHERE has_citation = false;

CREATE INDEX IF NOT EXISTS wiki_paragraph_embeddings_title
  ON wiki_paragraph_embeddings (title);
