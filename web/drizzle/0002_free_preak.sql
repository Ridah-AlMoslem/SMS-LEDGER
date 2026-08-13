CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."cadence" AS ENUM('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."recurring_kind" AS ENUM('subscription', 'bill', 'salary', 'profit');--> statement-breakpoint
CREATE TYPE "public"."series_status" AS ENUM('active', 'paused', 'cancelled');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"severity" "alert_severity" DEFAULT 'info' NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"rollover" boolean DEFAULT false NOT NULL,
	"cycle_start" date NOT NULL,
	CONSTRAINT "budgets_category_cycle" UNIQUE("category_id","cycle_start"),
	CONSTRAINT "budgets_cycle_start_is_anchor" CHECK (EXTRACT(DAY FROM "budgets"."cycle_start") = 25)
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"target_amount" numeric(14, 2) NOT NULL,
	"target_date" date,
	"linked_account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"lender" text,
	"principal" numeric(14, 2) NOT NULL,
	"apr" numeric(6, 4),
	"term_months" integer,
	"start_date" date,
	"payment_amount" numeric(14, 2),
	"payment_day" integer,
	"current_balance" numeric(14, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid,
	"account_id" uuid,
	"kind" "recurring_kind" NOT NULL,
	"amount_avg" numeric(14, 2),
	"amount_last" numeric(14, 2),
	"day_of_month" integer,
	"cadence" "cadence" NOT NULL,
	"next_expected_at" date,
	"first_seen" timestamp with time zone,
	"last_seen" timestamp with time zone,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"status" "series_status" DEFAULT 'active' NOT NULL,
	"confidence" numeric(4, 3)
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"match" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"cycle_anchor_day" integer DEFAULT 25 NOT NULL,
	"week_start_dow" integer DEFAULT 0 NOT NULL,
	"timezone" text DEFAULT 'Asia/Riyadh' NOT NULL,
	CONSTRAINT "settings_single_row" CHECK ("settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "recurring_series_id" uuid;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_linked_account_id_accounts_id_fk" FOREIGN KEY ("linked_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_open_idx" ON "alerts" USING btree ("dismissed_at","created_at");--> statement-breakpoint
CREATE INDEX "budgets_cycle_idx" ON "budgets" USING btree ("cycle_start");--> statement-breakpoint
CREATE INDEX "rules_priority_idx" ON "rules" USING btree ("enabled","priority");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurring_series_id_recurring_series_id_fk" FOREIGN KEY ("recurring_series_id") REFERENCES "public"."recurring_series"("id") ON DELETE set null ON UPDATE no action;