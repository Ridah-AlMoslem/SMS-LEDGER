ALTER TABLE "transactions" ADD COLUMN "card_last4" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "parser_kind" text;--> statement-breakpoint
CREATE INDEX "transactions_card_posted_idx" ON "transactions" USING btree ("card_last4","posted_at");