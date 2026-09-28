CREATE TABLE "article_views" (
	"article_id" uuid NOT NULL,
	"visitor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_views_article_id_visitor_id_pk" PRIMARY KEY("article_id","visitor_id")
);
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "article_views" ADD CONSTRAINT "article_views_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_views_article_id_idx" ON "article_views" USING btree ("article_id");