CREATE TABLE "workshop_known_models" (
	"provider" text NOT NULL,
	"model_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workshop_known_models_provider_model_name_pk" PRIMARY KEY("provider","model_name")
);
--> statement-breakpoint
INSERT INTO "workshop_known_models" (provider, model_name) VALUES
	('xai', 'grok-4-1-fast-non-reasoning'),
	('xai', 'grok-4-1-fast-reasoning')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE "workshop_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"source_article_id" uuid,
	"claim_text" text NOT NULL,
	"start_stage" integer NOT NULL,
	"stage_config" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error_message" text,
	"result_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workshop_runs_status_check" CHECK ("workshop_runs"."status" IN ('running', 'done', 'error')),
	CONSTRAINT "workshop_runs_start_stage_check" CHECK ("workshop_runs"."start_stage" IN (1, 5, 7))
);
--> statement-breakpoint
ALTER TABLE "workshop_runs" ADD CONSTRAINT "workshop_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_runs" ADD CONSTRAINT "workshop_runs_source_article_id_articles_id_fk" FOREIGN KEY ("source_article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workshop_runs_created_by_user_id_idx" ON "workshop_runs" USING btree ("created_by_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workshop_runs_source_article_id_idx" ON "workshop_runs" USING btree ("source_article_id");