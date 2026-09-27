CREATE TABLE "backtest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"symbol_id" uuid NOT NULL,
	"timeframe" text NOT NULL,
	"range_from" timestamp with time zone NOT NULL,
	"range_to" timestamp with time zone NOT NULL,
	"initial_capital" double precision NOT NULL,
	"account_currency" text NOT NULL,
	"costs" jsonb NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warmup_bars" integer DEFAULT 0 NOT NULL,
	"engine_id" text NOT NULL,
	"engine_version" text NOT NULL,
	"data_version" integer NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"summary" jsonb,
	"cross_check_ok" boolean,
	"cross_check_delta_pct" double precision,
	"bars_processed" integer,
	"engine_ms" integer,
	"total_ms" integer,
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
CREATE TABLE "run_series" (
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"format" text NOT NULL,
	"point_count" integer NOT NULL,
	"payload" "bytea" NOT NULL,
	"uncompressed_bytes" integer NOT NULL,
	CONSTRAINT "run_series_run_id_kind_pk" PRIMARY KEY("run_id","kind")
);
--> statement-breakpoint
CREATE TABLE "run_trades" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"side" text NOT NULL,
	"qty" double precision NOT NULL,
	"entry_ts" timestamp with time zone NOT NULL,
	"exit_ts" timestamp with time zone NOT NULL,
	"entry_bar" integer NOT NULL,
	"exit_bar" integer NOT NULL,
	"entry_price" double precision NOT NULL,
	"exit_price" double precision NOT NULL,
	"gross_pnl" double precision NOT NULL,
	"commission" double precision DEFAULT 0 NOT NULL,
	"slippage_cost" double precision DEFAULT 0 NOT NULL,
	"spread_cost" double precision DEFAULT 0 NOT NULL,
	"financing_cost" double precision DEFAULT 0 NOT NULL,
	"net_pnl" double precision NOT NULL,
	"mae" double precision,
	"mfe" double precision,
	"bars_held" integer,
	"exit_reason" text,
	CONSTRAINT "run_trades_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"pine_source" text NOT NULL,
	"source_hash" text NOT NULL,
	"pine_version" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_metrics" ADD CONSTRAINT "run_metrics_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_series" ADD CONSTRAINT "run_series_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_trades" ADD CONSTRAINT "run_trades_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backtest_runs_version_idx" ON "backtest_runs" USING btree ("strategy_version_id");--> statement-breakpoint
CREATE INDEX "backtest_runs_state_idx" ON "backtest_runs" USING btree ("state");--> statement-breakpoint
CREATE INDEX "backtest_runs_symbol_tf_idx" ON "backtest_runs" USING btree ("symbol_id","timeframe");--> statement-breakpoint
CREATE INDEX "backtest_runs_created_idx" ON "backtest_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "run_trades_exit_idx" ON "run_trades" USING btree ("run_id","exit_ts");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_versions_hash_idx" ON "strategy_versions" USING btree ("strategy_id","source_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_versions_number_idx" ON "strategy_versions" USING btree ("strategy_id","version");