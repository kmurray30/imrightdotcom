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

-- No ANN (vector search) index here on purpose: ivfflat picks its cluster
-- centers from the rows present when it's built, so creating it on this
-- empty table gives poor search results forever. Build it once the table is
-- loaded with wiki_searcher/scripts/create-ann-index.js.
--
-- No separate title index either: UNIQUE (title, paragraph_index) above
-- already provides an index with title as its leading column.

-- arctic-embed-m-v1.5 vectors for the same paragraphs (see
-- wiki_searcher/arcticEmbeddings.js), cut to 256 dims and stored at half
-- precision: the source for the compact (4-bit) search index that replaces
-- the bge ANN index above. Filled by wiki_searcher/scripts/reembed-arctic.js
-- (which also creates this table). Rows follow their paragraph: deleting or
-- replacing a paragraph removes its vector too.
CREATE TABLE IF NOT EXISTS wiki_paragraph_vectors_arctic (
  id        BIGINT PRIMARY KEY REFERENCES wiki_paragraph_embeddings (id) ON DELETE CASCADE,
  embedding halfvec(256) NOT NULL
);
