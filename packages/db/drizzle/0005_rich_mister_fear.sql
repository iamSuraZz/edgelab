CREATE TABLE "holdouts" (
	"symbol_id" uuid PRIMARY KEY NOT NULL,
	"sealed_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "holdouts" ADD CONSTRAINT "holdouts_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;