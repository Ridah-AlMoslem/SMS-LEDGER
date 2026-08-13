-- Period functions, the categorized-amount view, and split integrity.
-- SPEC §5.1, §5.2, §5.5, §9.6. Milestone 0 (§12): everything downstream
-- depends on these, and nothing may bypass them.
--
-- Why the anchors are hardcoded here when settings.cycle_anchor_day exists:
-- an IMMUTABLE function may not read a table, and a non-IMMUTABLE function
-- cannot appear in an index expression. Since §5.1 requires that index, the
-- functions carry the literals and the settings row carries them for
-- everything above SQL. Changing an anchor is therefore a migration, which is
-- the correct weight for a change that redefines every historical aggregate.

--> statement-breakpoint

-- One row, always. Every reader assumes it exists.
INSERT INTO settings (id, cycle_anchor_day, week_start_dow, timezone)
VALUES (1, 25, 0, 'Asia/Riyadh')
ON CONFLICT (id) DO NOTHING;

--> statement-breakpoint

-- §5.5 — bucket in local time, never UTC. A purchase at 01:00 local on the
-- 25th is 22:00 UTC on the 24th and lands in the *previous* cycle if you take
-- posted_at::date, because that cast reads the session TimeZone.
--
-- This also makes the cast indexable: `timestamptz::date` is STABLE (it
-- depends on a GUC), so Postgres rejects it in an index expression outright.
-- `AT TIME ZONE '<literal>'` is IMMUTABLE, so this one is accepted.
CREATE OR REPLACE FUNCTION local_date(ts timestamptz) RETURNS date AS $$
  SELECT (ts AT TIME ZONE 'Asia/Riyadh')::date;
$$ LANGUAGE sql IMMUTABLE STRICT;

--> statement-breakpoint

-- §5.1 — the financial month runs 25th → 24th, aligned to payday.
-- Day 25 is a safe anchor: every month has one, unlike 29/30/31.
CREATE OR REPLACE FUNCTION period_start(d date) RETURNS date AS $$
  SELECT CASE WHEN EXTRACT(DAY FROM d) >= 25
              THEN date_trunc('month', d)::date + 24
              ELSE (date_trunc('month', d) - interval '1 month')::date + 24
         END;
$$ LANGUAGE sql IMMUTABLE STRICT;

--> statement-breakpoint

-- Inclusive. Length varies 28–31; never hardcode 30 anywhere downstream.
CREATE OR REPLACE FUNCTION period_end(d date) RETURNS date AS $$
  SELECT (public.period_start(d) + interval '1 month - 1 day')::date;
$$ LANGUAGE sql IMMUTABLE STRICT;

--> statement-breakpoint

-- §5.1 — name the cycle after the month it ENDS in: 2026-07-25 → 2026-08-24
-- is "August 2026", because the salary landing on 25 July is August's money.
--
-- The month name is spelled out from an array rather than via to_char(), which
-- is STABLE (it reads lc_time) and would make this function unindexable and
-- its output dependent on server locale. A label that changes with a database
-- setting is not a label.
CREATE OR REPLACE FUNCTION period_label(d date) RETURNS text AS $$
  SELECT (ARRAY['January','February','March','April','May','June','July',
                'August','September','October','November','December']
         )[EXTRACT(MONTH FROM public.period_end(d))::int]
         || ' ' || EXTRACT(YEAR FROM public.period_end(d))::text;
$$ LANGUAGE sql IMMUTABLE STRICT;

--> statement-breakpoint

-- §5.2 — weeks start Sunday, matching the Sun–Thu work week, so Fri–Sat
-- weekend spend lands together instead of split across two buckets.
-- Postgres date_trunc('week') is Monday-based; shift it by a day either side.
CREATE OR REPLACE FUNCTION week_start(d date) RETURNS date AS $$
  SELECT (date_trunc('week', d + 1) - interval '1 day')::date;
$$ LANGUAGE sql IMMUTABLE STRICT;

--> statement-breakpoint

-- §5.6 — the cycle a transaction budgets. Salary carries an explicit override
-- (a due date the bank stated, or a snap to the nearest boundary) so payday
-- drift never moves which cycle the money funds. Everything else falls through
-- to its own posting date.
--
-- Weeks deliberately have no equivalent: a week is a literal date range and
-- always ignores cycle_override.
CREATE OR REPLACE FUNCTION effective_cycle(posted_at timestamptz, cycle_override date)
RETURNS date AS $$
  SELECT COALESCE(cycle_override, public.period_start(public.local_date(posted_at)));
$$ LANGUAGE sql IMMUTABLE;

--> statement-breakpoint

-- §5.1 requires this index so cycle filtering stays fast.
CREATE INDEX IF NOT EXISTS transactions_period_start_idx
  ON transactions (period_start(local_date(posted_at)));

--> statement-breakpoint

-- The one every aggregate actually filters on, since §5.6 makes all cycle
-- aggregates read COALESCE(cycle_override, ...).
CREATE INDEX IF NOT EXISTS transactions_effective_cycle_idx
  ON transactions (effective_cycle(posted_at, cycle_override));

--> statement-breakpoint

-- §9.6 — a transaction is categorized either on the row or across
-- transaction_splits, never both. This view emits exactly one row per
-- (transaction, category, amount) so that aggregation is uniform, and direct
-- aggregation over `transactions` is forbidden: a query that forgets splits
-- either double-counts them or drops them, and both look plausible.
--
-- The cycle and week columns are materialised here so no caller ever has to
-- remember the timezone or the Sunday shift. Note cycle_start honours the
-- override and week_start does not — that asymmetry is §5.6, not an oversight.
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
   WHERE NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id);

--> statement-breakpoint

-- §9.6 — Σ splits = transactions.amount, enforced rather than hoped for.
--
-- The view's correctness rests entirely on this: if the legs do not sum to the
-- whole, the view quietly reports a different total than the ledger and no
-- individual screen looks wrong.
--
-- DEFERRABLE INITIALLY DEFERRED because splitting a transaction is inherently
-- a multi-statement operation — the first leg inserted is always "wrong" on
-- its own. Checking at commit is the only version that is both strict and
-- usable. Zero splits is valid: that is an uncategorized-on-the-row
-- transaction, which the view's second branch covers.
CREATE OR REPLACE FUNCTION assert_split_total(tx_id uuid) RETURNS void AS $$
DECLARE
  total numeric(14,2);
  whole numeric(14,2);
BEGIN
  SELECT amount INTO whole FROM transactions WHERE id = tx_id;
  -- The transaction went away in the same transaction; the cascade took its
  -- legs with it and there is nothing left to be inconsistent with.
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(sum(amount), 0) INTO total
    FROM transaction_splits WHERE transaction_id = tx_id;

  IF total <> 0 AND total <> whole THEN
    RAISE EXCEPTION
      'split total % does not equal transaction amount % (transaction %)',
      total, whole, tx_id
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

-- NEW is unassigned in a DELETE trigger and OLD in an INSERT trigger, so the
-- row is picked by TG_OP rather than by COALESCE over both.
CREATE OR REPLACE FUNCTION check_split_total() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_split_total(OLD.transaction_id);
  ELSE
    PERFORM assert_split_total(NEW.transaction_id);
    -- An UPDATE that moves a leg to another transaction leaves two totals to
    -- check, not one.
    IF TG_OP = 'UPDATE' AND OLD.transaction_id <> NEW.transaction_id THEN
      PERFORM assert_split_total(OLD.transaction_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE CONSTRAINT TRIGGER transaction_splits_sum_to_whole
  AFTER INSERT OR UPDATE OR DELETE ON transaction_splits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_split_total();

--> statement-breakpoint

-- Editing transactions.amount must not silently invalidate existing legs.
CREATE OR REPLACE FUNCTION check_amount_matches_splits() RETURNS trigger AS $$
BEGIN
  PERFORM assert_split_total(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE CONSTRAINT TRIGGER transactions_amount_matches_splits
  AFTER UPDATE OF amount ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_amount_matches_splits();
