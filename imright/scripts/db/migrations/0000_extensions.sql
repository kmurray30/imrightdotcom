-- gen_random_uuid() needs pgcrypto (not always enabled by default; don't
-- assume it, add it explicitly so a fresh Railway Postgres doesn't fail on
-- the first migration). citext backs case-insensitive username/email
-- uniqueness on `users`. pg_trgm backs the ILIKE search index on `articles`.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
