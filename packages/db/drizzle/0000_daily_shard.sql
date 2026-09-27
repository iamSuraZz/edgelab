CREATE TABLE "candles_m1" (
	"symbol_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"volume" double precision DEFAULT 0 NOT NULL,
	"spread" double precision,
	"source" text NOT NULL,
	CONSTRAINT "candles_m1_symbol_id_ts_pk" PRIMARY KEY("symbol_id","ts")
);
--> statement-breakpoint
CREATE TABLE "equity_points" (
	"run_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"equity" double precision NOT NULL,
	"drawdown" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "equity_points_run_id_ts_pk" PRIMARY KEY("run_id","ts")
);
--> statement-breakpoint
CREATE TABLE "ingest_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"range_from" timestamp with time zone NOT NULL,
	"range_to" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"bars_written" integer DEFAULT 0 NOT NULL,
	"percent" integer DEFAULT 0 NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"error" text,
	"queue_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_metrics" (
	"run_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"value" double precision,
	CONSTRAINT "run_metrics_run_id_metric_key_pk" PRIMARY KEY("run_id","metric_key")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"symbol_id" uuid NOT NULL,
	"timeframe" text NOT NULL,
	"range_from" timestamp with time zone NOT NULL,
	"range_to" timestamp with time zone NOT NULL,
	"initial_capital" double precision NOT NULL,
	"account_currency" text NOT NULL,
	"costs" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"pine_source" text NOT NULL,
	"pine_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "symbols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"asset_class" text NOT NULL,
	"base_ccy" text NOT NULL,
	"quote_ccy" text NOT NULL,
	"digits" integer NOT NULL,
	"mintick" double precision NOT NULL,
	"pip_size" double precision NOT NULL,
	"contract_size" double precision NOT NULL,
	"point_value" double precision DEFAULT 1 NOT NULL,
	"default_spread_points" double precision DEFAULT 0 NOT NULL,
	"provider_symbols" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"session_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"data_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "symbols_symbol_unique" UNIQUE("symbol")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"side" text NOT NULL,
	"entry_ts" timestamp with time zone NOT NULL,
	"exit_ts" timestamp with time zone,
	"entry_price" double precision NOT NULL,
	"exit_price" double precision,
	"quantity" double precision NOT NULL,
	"gross_pnl" double precision,
	"commission" double precision DEFAULT 0 NOT NULL,
	"spread_cost" double precision DEFAULT 0 NOT NULL,
	"swap_cost" double precision DEFAULT 0 NOT NULL,
	"net_pnl" double precision,
	"bars_held" integer,
	"exit_reason" text
);
--> statement-breakpoint
ALTER TABLE "candles_m1" ADD CONSTRAINT "candles_m1_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_points" ADD CONSTRAINT "equity_points_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_jobs" ADD CONSTRAINT "ingest_jobs_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_metrics" ADD CONSTRAINT "run_metrics_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_jobs_symbol_idx" ON "ingest_jobs" USING btree ("symbol_id");--> statement-breakpoint
CREATE INDEX "ingest_jobs_state_idx" ON "ingest_jobs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "runs_strategy_idx" ON "runs" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "runs_state_idx" ON "runs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "symbols_asset_class_idx" ON "symbols" USING btree ("asset_class");--> statement-breakpoint
CREATE INDEX "trades_run_seq_idx" ON "trades" USING btree ("run_id","seq");