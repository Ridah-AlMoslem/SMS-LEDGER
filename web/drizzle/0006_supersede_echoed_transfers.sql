ALTER TABLE "transactions" ADD COLUMN "superseded_by" uuid;
--> statement-breakpoint

-- A superseded leg is a duplicate description, not a duplicate movement, so it
-- must leave every derived total alone. The view is rebuilt rather than
-- patched, because a WHERE clause cannot be added to one in place.
--
-- The rows stay queryable directly — "why does the ledger show one transfer
-- when two messages arrived" has to be answerable — they simply stop counting.
CREATE OR REPLACE VIEW v_categorized_amounts AS
  SELECT t.id            AS transaction_id,
         s.id            AS split_id,
         s.category_id   AS category_id,
         s.amount        AS amount,
         true            AS is_split,
         t.account_id,
         t.posted_at,
         t.direction,
         t.type,
         t.state,
         t.merchant_id,
         t.is_internal_transfer,
         t.excluded_from_analytics,
         effective_cycle(t.posted_at, t.cycle_override) AS cycle_start,
         week_start(local_date(t.posted_at))            AS week_start,
         local_date(t.posted_at)                        AS local_day
    FROM transactions t
    JOIN transaction_splits s ON s.transaction_id = t.id
   WHERE t.superseded_by IS NULL
  UNION ALL
  SELECT t.id,
         NULL::uuid,
         t.category_id,
         t.amount,
         false,
         t.account_id,
         t.posted_at,
         t.direction,
         t.type,
         t.state,
         t.merchant_id,
         t.is_internal_transfer,
         t.excluded_from_analytics,
         effective_cycle(t.posted_at, t.cycle_override),
         week_start(local_date(t.posted_at)),
         local_date(t.posted_at)
    FROM transactions t
   WHERE t.superseded_by IS NULL
     AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id);

--> statement-breakpoint

-- Migration 0004 set this on the original. Restating it means a future rebuild
-- of this view cannot silently drop the RLS behaviour and reopen the read path
-- that migration closed.
ALTER VIEW v_categorized_amounts SET (security_invoker = on);

--> statement-breakpoint

-- Finding the echoes: recent two-leg internal transfers not yet superseded.
CREATE INDEX IF NOT EXISTS transactions_transfer_dedup_idx
  ON transactions (posted_at)
  WHERE is_internal_transfer AND superseded_by IS NULL;
