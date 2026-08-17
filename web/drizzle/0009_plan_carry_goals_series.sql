-- Plan's three segments, on the database side. SPEC §11.2, §11.3,
-- milestone 10 (§12).
--
-- Three things are added, and each one exists because the obvious alternative
-- is wrong in a way that is invisible on screen:
--
--   1. `budgets.carry_in` — the rollover carry, STORED. §11.2: "Carry is stored
--      per cycle when the cycle closes, not recomputed from the beginning of
--      time, so a single corrected old transaction can't cascade through years
--      of budgets." A fold over history computed at read time is the version
--      that cascades: correcting a mis-parsed purchase from March would move
--      April's carry, which moves May's, which moves the allowance on the
--      screen you are looking at today. The whole point of rollover is that
--      last cycle's outcome is settled.
--
--      `carry_closed_at` is what makes it settled rather than merely cached.
--      Once set, nothing recomputes that figure: not the nightly close running
--      twice, not a late correction, not a replay. Cleared only by hand, via
--      the "reset carry" button §11.2 asks for.
--
--   2. `goals.allocation` — the size of the virtual bucket, which is NOT the
--      progress. Progress is read from the linked account's real balance
--      (§11.2), so it cannot drift; the allocation is the claim this goal makes
--      on that balance, and it is a claim precisely because several goals may
--      share one account and their claims must be checked against it. Storing
--      progress here instead would be the separate counter the SPEC forbids.
--
--   3. The recurring detector's bookkeeping. `detect_key` is the identity a
--      re-run recognises a series by, so the nightly pass updates rather than
--      duplicates. The three human decisions — confirmed, dismissed as noise,
--      excluded from detection — are stored separately from `status` because
--      they answer a different question: `status` is what the series is doing,
--      these are what the detector is allowed to conclude about it.

--> statement-breakpoint

-- Signed. Underspend raises the next cycle's allowance; overspend lowers it
-- (§11.2). Never displayed folded into `amount` — a 2,000 base against a
-- −1,800 carry has 200 to spend, and rendering only the 200 makes an emergency
-- look like a policy.
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS carry_in numeric(14,2) NOT NULL DEFAULT 0;

--> statement-breakpoint

-- Set when the previous cycle's outcome has been folded in, or when the carry
-- was reset by hand. Non-NULL means "settled": `closeCycle` skips the row.
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS carry_closed_at timestamptz;

--> statement-breakpoint

-- The bucket. Zero is a real value: a goal with no allocation yet is a target
-- with nothing behind it, which is different from no goal.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS allocation numeric(14,2) NOT NULL DEFAULT 0;

--> statement-breakpoint

ALTER TABLE goals ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

--> statement-breakpoint

-- A negative bucket would make the unallocated remainder larger than the
-- balance, which reads as free money.
ALTER TABLE goals ADD CONSTRAINT goals_allocation_not_negative CHECK (allocation >= 0);

--> statement-breakpoint

ALTER TABLE goals ADD CONSTRAINT goals_target_is_positive CHECK (target_amount > 0);

--> statement-breakpoint

-- (merchant identity | account | kind), built by the detector. Text rather than
-- the three columns as a composite key because two of them are nullable — a
-- SADAD bill has no merchant row and a salary has no merchant at all — and
-- UNIQUE treats NULLs as distinct, so the composite version would let the
-- nightly pass insert a second copy of the same series every night.
ALTER TABLE recurring_series ADD COLUMN IF NOT EXISTS detect_key text;

--> statement-breakpoint

-- What to call the series on screen.
--
-- Stored rather than derived, because there is no single place to derive it
-- from: a subscription has a merchant row, a SADAD bill has only a biller
-- string (§7.5), a salary has neither, and a profit payout is named after the
-- account it lands in. The detector resolves that chain once, on rows it is
-- already reading. Reconstructing it at read time from `detect_key` puts the
-- normalised key on the screen instead — `stc` where STC belongs, and
-- `profit:saib_savings` where a person expects "SAIB Savings profit".
ALTER TABLE recurring_series ADD COLUMN IF NOT EXISTS label text;

--> statement-breakpoint

-- The median gap the detector actually measured, in days. `cadence` is the
-- bucket it was rounded into; this is the number, and it is what the next
-- expected date is computed from for weekly and biweekly series.
ALTER TABLE recurring_series ADD COLUMN IF NOT EXISTS interval_days integer;

--> statement-breakpoint

-- The amount before the last change, and when the change was first charged.
-- §11.3 — "silent annual price bumps are the main thing this catches", and a
-- flag that cannot say what the price used to be is not evidence of anything.
ALTER TABLE recurring_series ADD COLUMN IF NOT EXISTS amount_prev numeric(14,2);

--> statement-breakpoint

ALTER TABLE recurring_series ADD COLUMN IF NOT EXISTS price_change_at date;

--> statement-breakpoint

-- "Yes, this is real." Keeps a series in the bills calendar even when a missed
-- charge or an irregular gap would otherwise drop its confidence below the
-- display floor.
ALTER TABLE recurring_series ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

--> statement-breakpoint

-- "This is not a subscription." The series stays as a tombstone so the nightly
-- pass recognises the pattern and stays quiet about it, instead of rediscovering
-- it with a fresh id every night.
ALTER TABLE recurring_series ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

--> statement-breakpoint

-- Stronger than dismissed: the detector may not draw conclusions from this
-- merchant on this account at all, so the amounts and the cadence stop being
-- updated too.
ALTER TABLE recurring_series
  ADD COLUMN IF NOT EXISTS excluded_from_detection boolean NOT NULL DEFAULT false;

--> statement-breakpoint

-- What makes the nightly pass an upsert rather than an insert.
CREATE UNIQUE INDEX IF NOT EXISTS recurring_series_detect_key_idx
  ON recurring_series (detect_key);

--> statement-breakpoint

-- The upcoming-bills list: active series ordered by when they are next due.
CREATE INDEX IF NOT EXISTS recurring_series_next_expected_idx
  ON recurring_series (next_expected_at)
  WHERE status = 'active' AND dismissed_at IS NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS goals_account_idx ON goals (linked_account_id);

--> statement-breakpoint

-- §4 — `transactions.recurring_series_id` links an occurrence back to the
-- series that predicted it, which is what makes a series row drillable into the
-- charges it was derived from.
CREATE INDEX IF NOT EXISTS transactions_recurring_series_idx
  ON transactions (recurring_series_id)
  WHERE recurring_series_id IS NOT NULL;
