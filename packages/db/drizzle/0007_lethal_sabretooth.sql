CREATE TABLE "validation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"verdict" text,
	"report" jsonb,
	"spec" jsonb,
	"feed" text,
	"data_version" integer,
	"engine_id" text,
	"engine_version" text,
	"holdout_id" uuid,
	"holdout_view_count" integer,
	"range_from" timestamp with time zone,
	"range_to" timestamp with time zone,
	"requested_range_to" timestamp with time zone,
	"error" text,
	"elapsed_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "validation_runs_run_idx" ON "validation_runs" USING btree ("run_id","created_at");