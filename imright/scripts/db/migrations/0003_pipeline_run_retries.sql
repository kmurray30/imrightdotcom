-- Hand-edited from the drizzle-kit-generated version: it emitted
-- ADD COLUMN claim_text text NOT NULL with no default, which fails outright
-- if pipeline_runs already has any rows (it does, in prod — the run that
-- started this whole investigation). A default backfills existing rows;
-- every new INSERT still always provides a real claimText explicitly.
ALTER TABLE "pipeline_runs" ADD COLUMN "claim_text" text NOT NULL DEFAULT '';--> statement-breakpoint
-- Drop the default once existing rows are backfilled, so the live column
-- matches schema.js exactly (no default — every INSERT provides it).
ALTER TABLE "pipeline_runs" ALTER COLUMN "claim_text" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;