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


-- Cited spans: the unit the rebuilt index stores and embeds. One row per
-- citation group inside a paragraph (or list item / table row): the text
-- between the previous citation and this one, with this group's citations.
-- Nothing uncited is stored. Extracted from Wikimedia Enterprise's rendered
-- HTML by wiki_searcher/spanExtractor.js; filled by
-- wiki_searcher/scripts/build-index-from-wikimedia.js (which also creates the
-- table). Vectors are arctic-embed-m-v1.5 cut to 256 dims
-- (wiki_searcher/arcticEmbeddings.js); the compact search index is built from
-- them separately. Replaces wiki_paragraph_embeddings once serving switches.
CREATE TABLE IF NOT EXISTS wiki_citation_spans (
  id                 BIGSERIAL PRIMARY KEY,
  title              TEXT NOT NULL,
  page_id            BIGINT,               -- Wikimedia article identifier (survives renames)
  version_identifier BIGINT,               -- Wikimedia revision; matched on re-run to skip current articles
  section            TEXT NOT NULL,
  kind               TEXT NOT NULL,        -- 'paragraph' | 'list_item' | 'table_row'
  unit_index         INT NOT NULL,         -- nth unit of that kind in the article
  span_index         INT NOT NULL,         -- nth citation group within the unit
  span_text          TEXT NOT NULL,        -- the text this group's citations support (cleaned, no markup)
  citations          JSONB NOT NULL,       -- [{type, url, archive_url, title, publisher, date}], deduped by url
  embedding          halfvec(256) NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (title, kind, unit_index, span_index)
);

CREATE INDEX IF NOT EXISTS wiki_citation_spans_page_id ON wiki_citation_spans (page_id);

-- Cited spans that are stored but NOT embedded: every citation is offline
-- (a book with no url, an {{sfn}} footnote resolved to its bibliography
-- entry, a plain-text reference, an excluded host) or the span is under the
-- size floor. Same locator/content columns and key as wiki_citation_spans,
-- so span_index numbering is shared and unique across both tables. Kept so a
-- later change of rules never needs the snapshot again.
CREATE TABLE IF NOT EXISTS wiki_citation_spans_unembedded (
  id                 BIGSERIAL PRIMARY KEY,
  title              TEXT NOT NULL,
  page_id            BIGINT,
  version_identifier BIGINT,
  section            TEXT NOT NULL,
  kind               TEXT NOT NULL,
  unit_index         INT NOT NULL,
  span_index         INT NOT NULL,
  span_text          TEXT NOT NULL,
  citations          JSONB NOT NULL,       -- same shape; offline citations have url null and a `text` with the rendered reference
  reason             TEXT NOT NULL,        -- 'no_online_citation' | 'short'
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (title, kind, unit_index, span_index)
);

CREATE INDEX IF NOT EXISTS wiki_citation_spans_unembedded_page_id ON wiki_citation_spans_unembedded (page_id);
