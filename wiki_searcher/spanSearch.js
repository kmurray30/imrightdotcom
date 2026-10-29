/**
 * Semantic search over the cited spans (wiki_citation_spans): each search
 * term is embedded with arctic (arcticEmbeddings.js, the model that embedded
 * the spans), then matched against the spans' vectors in Postgres.
 *
 * Two steps per term, in one query: the ivfflat index on the vectors' binary
 * quantization (wiki_citation_spans_ann, built by
 * scripts/create-ann-index.js --spans) yields the CANDIDATES nearest by
 * Hamming distance, which are then re-ranked by exact cosine distance on the
 * stored halfvec. The bit index is ~3 GB for ~59M spans; the halfvec vectors
 * themselves would need a ~32 GB index.
 */
import { getPool } from '../imright/scripts/db.js';
import { embedQueries, ARCTIC_DIMS } from './arcticEmbeddings.js';
import { SPANS_TABLE } from './embeddingIndex.js';

// How many of the index's 4000 lists each search scans, and how many
// Hamming-nearest candidates are re-ranked by exact distance; higher = better
// recall, slower. Measured on 16 queries (check-span-search.js) against a
// near-exhaustive reference: at 100 / 800 the top 10 is 0.018 less similar on
// average (of 0.575), in ~0.55 s; at 63 / 400, 0.027 in ~0.4 s.
// SPAN_SEARCH_PROBES / SPAN_SEARCH_CANDIDATES override.
const DEFAULT_PROBES = 100;
const DEFAULT_CANDIDATES = 800;
const SORT_MEMORY = '128MB';

const toHalfvecLiteral = (vector) => `[${Array.from(vector).join(',')}]`;

/**
 * @param {string[]} terms
 * @param {object} [options]
 * @param {number} [options.limit] - Spans returned per term.
 * @returns {Promise<Array<Array<{ title: string, section: string, kind: string, text: string, citations: object[], score: number }>>>}
 *   Per term (in input order), its best spans first; score is cosine similarity.
 */
export async function searchSpans(terms, { limit = 20 } = {}) {
  const pool = getPool();
  if (!pool) throw new Error('DATABASE_URL is not set; cannot search the wiki citation spans.');
  const probes = Math.max(1, Math.floor(Number(process.env.SPAN_SEARCH_PROBES) || DEFAULT_PROBES));
  const candidates = Math.max(limit, Math.floor(Number(process.env.SPAN_SEARCH_CANDIDATES) || DEFAULT_CANDIDATES));
  const vectors = await embedQueries(terms);
  return Promise.all(vectors.map((vector) => searchOne(pool, toHalfvecLiteral(vector), { probes, candidates, limit })));
}

async function searchOne(pool, vector, { probes, candidates, limit }) {
  // SET LOCAL inside a transaction on one checked-out client, so the probes
  // setting never leaks to other queries that later reuse this connection.
  const client = await pool.connect();
  const onClientError = () => {}; // a dropped connection rejects the query instead of crashing the process
  client.on('error', onClientError);
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ivfflat.probes = ${probes}`);
    // The index scan sorts every entry of the probed lists (~15k each); at the
    // default 4 MB that sort spills to disk and a search takes seconds.
    await client.query(`SET LOCAL work_mem = '${SORT_MEMORY}'`);
    const { rows } = await client.query(
      `WITH candidates AS MATERIALIZED (
         SELECT id, embedding FROM ${SPANS_TABLE}
         ORDER BY binary_quantize(embedding)::bit(${ARCTIC_DIMS}) <~> binary_quantize($1::halfvec(${ARCTIC_DIMS}))
         LIMIT $2
       ), best AS (
         SELECT id, 1 - (embedding <=> $1::halfvec(${ARCTIC_DIMS})) AS score FROM candidates
         ORDER BY embedding <=> $1::halfvec(${ARCTIC_DIMS})
         LIMIT $3
       )
       SELECT s.title, s.section, s.kind, s.span_text, s.citations, best.score
       FROM best JOIN ${SPANS_TABLE} s USING (id)
       ORDER BY best.score DESC`,
      [vector, candidates, limit]
    );
    await client.query('COMMIT');
    return rows.map((row) => ({ title: row.title, section: row.section, kind: row.kind, text: row.span_text, citations: row.citations, score: Number(row.score) }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.removeListener('error', onClientError);
    client.release();
  }
}
