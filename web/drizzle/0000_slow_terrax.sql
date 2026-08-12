CREATE TYPE "public"."account_type" AS ENUM('checking', 'savings', 'credit_card', 'loan', 'cash', 'wallet', 'cashback_wallet');--> statement-breakpoint
CREATE TYPE "public"."balance_semantics" AS ENUM('balance', 'available_credit');--> statement-breakpoint
CREATE TYPE "public"."card_scheme" AS ENUM('mada', 'visa', 'mastercard', 'applepay');--> statement-breakpoint
CREATE TYPE "public"."classification" AS ENUM('financial', 'otp', 'promo', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."ignored_reason" AS ENUM('otp', 'promo', 'declined', 'balance_alert', 'statement', 'notification', 'user');--> statement-breakpoint
CREATE TYPE "public"."income_class" AS ENUM('earned', 'passive', 'other');--> statement-breakpoint
CREATE TYPE "public"."language" AS ENUM('ar', 'en', 'mixed');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('pending', 'processing', 'parsed', 'ignored', 'needs_review', 'failed');--> statement-breakpoint
CREATE TYPE "public"."origin" AS ENUM('parsed', 'manual');--> statement-breakpoint
CREATE TYPE "public"."parse_method" AS ENUM('template', 'llm', 'manual');--> statement-breakpoint
CREATE TYPE "public"."snapshot_source" AS ENUM('sms', 'manual', 'computed');--> statement-breakpoint
CREATE TYPE "public"."template_kind" AS ENUM('purchase', 'withdrawal', 'transfer_in', 'transfer_out', 'deposit', 'refund', 'salary', 'profit', 'fee', 'card_payment', 'bill_payment', 'balance_alert', 'otp', 'notification');--> statement-breakpoint
CREATE TYPE "public"."transaction_state" AS ENUM('posted', 'pending', 'reversed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('purchase', 'withdrawal', 'transfer', 'card_payment', 'loan_payment', 'fee', 'refund', 'income', 'profit', 'bill_payment');--> statement-breakpoint
CREATE TABLE "account_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"institution" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "account_identifiers_scoped" UNIQUE("institution","kind","value")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"institution" text NOT NULL,
	"type" "account_type" NOT NULL,
	"is_liability" boolean DEFAULT false NOT NULL,
	"balance_semantics" "balance_semantics" DEFAULT 'balance' NOT NULL,
	"reconcilable" boolean DEFAULT true NOT NULL,
	"opening_balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"current_balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"balance_as_of" timestamp with time zone,
	"credit_limit" numeric(14, 2),
	"statement_day" integer,
	"due_day" integer,
	"is_profit_bearing" boolean DEFAULT false NOT NULL,
	"profit_payout_day" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"balance" numeric(14, 2) NOT NULL,
	"source" "snapshot_source" NOT NULL,
	"as_of" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"statement_date" date NOT NULL,
	"total_due" numeric(14, 2),
	"minimum_due" numeric(14, 2),
	"due_date" date,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"icon" text,
	"color" text,
	"is_income" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counterparties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"iban_suffix" text,
	"default_category_id" uuid,
	"is_owned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalized_name" text NOT NULL,
	"display_name" text NOT NULL,
	"default_category_id" uuid,
	CONSTRAINT "merchants_normalized_name_unique" UNIQUE("normalized_name")
);
--> statement-breakpoint
CREATE TABLE "raw_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender" text NOT NULL,
	"body" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"device_sent_at" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"body_hash" text NOT NULL,
	"status" "message_status" DEFAULT 'pending' NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"ignored_reason" "ignored_reason",
	"classification" "classification",
	"language" "language",
	"shape_hash" text,
	"template_id" uuid,
	"parse_method" "parse_method",
	"llm_response" jsonb,
	CONSTRAINT "raw_messages_body_hash_unique" UNIQUE("body_hash")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"computed_balance" numeric(14, 2) NOT NULL,
	"reported_balance" numeric(14, 2) NOT NULL,
	"delta" numeric(14, 2) NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "sms_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender" text NOT NULL,
	"shape_hash" text NOT NULL,
	"language" "language" NOT NULL,
	"pattern" text NOT NULL,
	"field_map" jsonb NOT NULL,
	"kind" "template_kind" NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"confidence" numeric(4, 3),
	"created_by" "parse_method" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_templates_shape_hash_unique" UNIQUE("shape_hash")
);
--> statement-breakpoint
CREATE TABLE "transaction_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_message_id" uuid,
	"account_id" uuid NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"direction" "direction" NOT NULL,
	"type" "transaction_type" NOT NULL,
	"state" "transaction_state" DEFAULT 'posted' NOT NULL,
	"biller" text,
	"biller_service" text,
	"invoice_number" text,
	"income_class" "income_class",
	"cycle_override" date,
	"merchant_raw" text,
	"merchant_id" uuid,
	"category_id" uuid,
	"description" text,
	"notes" text,
	"transfer_group_id" uuid,
	"counterparty_account_id" uuid,
	"counterparty_id" uuid,
	"is_internal_transfer" boolean DEFAULT false NOT NULL,
	"reverses_transaction_id" uuid,
	"refunds_transaction_id" uuid,
	"refunded_amount" numeric(14, 2),
	"original_amount" numeric(14, 2),
	"original_currency" text,
	"fx_rate" numeric(18, 8),
	"fee_amount" numeric(14, 2),
	"country" text,
	"card_scheme" "card_scheme",
	"origin" "origin" DEFAULT 'parsed' NOT NULL,
	"locked_fields" jsonb,
	"matched_rule_id" uuid,
	"reported_balance" numeric(14, 2),
	"confidence" numeric(4, 3),
	"is_reviewed" boolean DEFAULT false NOT NULL,
	"excluded_from_analytics" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_one_per_message" UNIQUE("raw_message_id","account_id","direction")
);
--> statement-breakpoint
ALTER TABLE "account_identifiers" ADD CONSTRAINT "account_identifiers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_statements" ADD CONSTRAINT "card_statements_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_default_category_id_categories_id_fk" FOREIGN KEY ("default_category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_default_category_id_categories_id_fk" FOREIGN KEY ("default_category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_alerts" ADD CONSTRAINT "reconciliation_alerts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_raw_message_id_raw_messages_id_fk" FOREIGN KEY ("raw_message_id") REFERENCES "public"."raw_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "balance_snapshots_account_idx" ON "balance_snapshots" USING btree ("account_id","as_of");--> statement-breakpoint
CREATE INDEX "raw_messages_status_idx" ON "raw_messages" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "raw_messages_shape_idx" ON "raw_messages" USING btree ("shape_hash");--> statement-breakpoint
CREATE INDEX "transactions_account_posted_idx" ON "transactions" USING btree ("account_id","posted_at");--> statement-breakpoint
CREATE INDEX "transactions_posted_idx" ON "transactions" USING btree ("posted_at");--> statement-breakpoint
CREATE INDEX "transactions_transfer_group_idx" ON "transactions" USING btree ("transfer_group_id");