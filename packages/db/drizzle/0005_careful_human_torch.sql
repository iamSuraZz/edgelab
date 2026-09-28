CREATE TABLE "holdouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol_id" uuid NOT NULL,
	"sealed_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "holdouts" ADD CONSTRAINT "holdouts_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holdouts_one_active_per_symbol" ON "holdouts" USING btree ("symbol_id") WHERE "holdouts"."retired_at" IS NULL;