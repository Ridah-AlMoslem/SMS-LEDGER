-- The ledger's CRUD surface, and the two invariants it cannot be trusted
-- without. SPEC §9.4, §3.3, milestone 8 (§12).
--
-- Split integrity (Σ splits = transactions.amount) is already enforced by
-- migration 0003 — a constraint trigger, DEFERRABLE INITIALLY DEFERRED so a
-- multi-row split edit is legal in flight and illegal at commit. Nothing here
-- restates it; the split editor in the UI is a second opinion about a rule the
-- database already owns.
--
-- What is added here:
--
--   1. `locked_fields` is an array, or it is nothing. §9.4's guard is
--      `NOT (locked_fields ? 'category_id')`, and the `?` operator answers a
--      different question for an object than for an array — on an object it
--      tests keys. A row that stored `{"category_id": true}` would read as
--      locked by one query and unlocked by another, which is the one failure
--      mode this column exists to prevent.
--
--   2. Editing an amount recomputes the account's balance and re-derives every
--      open reconciliation alert against it. Balances here are derived
--      (`opening_balance + Σ posted legs`), so a hand-edited amount leaves
--      `accounts.current_balance` stating a figure the ledger beneath it no
--      longer supports — until the parser's next tick, which may be a minute
--      away or, if ingestion has stalled, days. A drift alert raised against
--      the old figure is worse: it goes on accusing an account of a
--      discrepancy that the edit either fixed or changed the size of.

--> statement-breakpoint

ALTER TABLE transactions
  ADD CONSTRAINT transactions_locked_fields_is_array
  CHECK (locked_fields IS NULL OR jsonb_typeof(locked_fields) = 'array');

--> statement-breakpoint

-- `recompute_balances` from api/db.py, scoped to one account.
--
-- The formula is copied rather than approximated, including both exclusions:
-- only `posted` legs count, and a superseded leg (§8.2.1) is a second
-- institution's description of one movement, not a second movement. If this
-- and the parser ever disagree, the balance flips between two values depending
-- on which of them ran last — a bug that presents as a number that changes
-- when nothing happened.
CREATE OR REPLACE FUNCTION recompute_account_balance(acc uuid) RETURNS numeric AS $$
DECLARE
  computed numeric(14,2);
BEGIN
  UPDATE accounts a
     SET current_balance = a.opening_balance + COALESCE(t.delta, 0),
         balance_as_of   = COALESCE(t.last_at, a.balance_as_of)
    FROM (
      SELECT SUM(CASE WHEN tx.direction = 'credit' THEN tx.amount
                      ELSE -tx.amount END) AS delta,
             MAX(tx.posted_at)             AS last_at
        FROM transactions tx
       WHERE tx.account_id = acc
         AND tx.state = 'posted'
         AND tx.superseded_by IS NULL
    ) t
   WHERE a.id = acc
  RETURNING a.current_balance INTO computed;

  RETURN computed;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

-- §3.3 — an alert states "computed X against the bank's Y, drift Z". Editing an
-- amount moves X, so all three are stale the moment the edit commits.
--
-- Re-derived rather than dismissed: the drift may have shrunk, grown, or
-- reversed sign, and only one of those outcomes means the alert should close.
-- `reconcile()` in api/db.py compares the account's CURRENT computed balance
-- against the latest SMS-reported one, so re-deriving from the same figure is
-- exactly what the next reconciliation pass would conclude — this only reaches
-- that conclusion now instead of at the next tick.
--
-- 0.01 is the same tolerance `reconcile()` uses, so an alert closed here is one
-- it would not re-raise a minute later.
CREATE OR REPLACE FUNCTION refresh_reconciliation(acc uuid) RETURNS void AS $$
DECLARE
  computed numeric(14,2);
BEGIN
  computed := recompute_account_balance(acc);
  IF computed IS NULL THEN RETURN; END IF;

  UPDATE reconciliation_alerts
     SET computed_balance = computed,
         delta            = computed - reported_balance,
         resolved_at      = CASE WHEN abs(computed - reported_balance) <= 0.01
                                 THEN now() ELSE NULL END,
         resolution_note  = CASE WHEN abs(computed - reported_balance) <= 0.01
                                 THEN 'balance agrees after a transaction was edited by hand'
                                 ELSE NULL END
   WHERE account_id = acc
     AND resolved_at IS NULL;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION transactions_touch_reconciliation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_reconciliation(OLD.account_id);
    RETURN NULL;
  END IF;

  PERFORM refresh_reconciliation(NEW.account_id);

  -- Moving a transaction to another account leaves two balances wrong, not one.
  IF TG_OP = 'UPDATE' AND OLD.account_id <> NEW.account_id THEN
    PERFORM refresh_reconciliation(OLD.account_id);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

-- Scoped to the four columns that change what the account is worth, and to the
-- statements a person can cause from this app.
--
-- Not fired on INSERT: the parser inserts in batches and calls
-- `recompute_balances` once at the end of its tick, so a per-row recompute
-- there would re-sum the account fifty times for one result. A manual entry
-- (§9.4) goes in as an INSERT too, so `db/ledger-mutations.ts` calls
-- `refresh_reconciliation` itself on that path — the one place where this
-- trigger's silence has to be made up for deliberately.
CREATE TRIGGER transactions_reconciliation_follows_edits
  AFTER UPDATE OF amount, direction, state, account_id OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_touch_reconciliation();

--> statement-breakpoint

-- The ledger list orders by (posted_at DESC, id DESC) and pages with a keyset
-- on the same pair. `transactions_posted_idx` covers the sort but not the
-- tiebreak, which is what makes a page boundary stable when several
-- transactions share a timestamp — and several always do, because a transfer's
-- two legs carry the same one.
CREATE INDEX IF NOT EXISTS transactions_posted_keyset_idx
  ON transactions (posted_at DESC, id DESC);

--> statement-breakpoint

-- Rules are matched against these three strings (§9.5, §11.1). A rule created
-- from a transaction's category picker turns into a scan over every historical
-- transaction, twice — once to preview, once to apply — and both have to give
-- the same answer fast enough that the preview is worth waiting for.
CREATE INDEX IF NOT EXISTS transactions_merchant_raw_idx
  ON transactions (lower(merchant_raw)) WHERE merchant_raw IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS transactions_biller_idx
  ON transactions (lower(biller)) WHERE biller IS NOT NULL;
