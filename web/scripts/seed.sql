-- Seed accounts and opening balances. Run once, after the migration.
--
--   psql "$DIRECT_URL" -f web/scripts/seed.sql
--
-- TEMPLATE — all balances are zeroed. Your real figures live in
-- seed.local.sql, which is gitignored, because opening balances are your net
-- worth and this file is committed.
--
--   cp web/scripts/seed.sql web/scripts/seed.local.sql   # then fill it in
--
-- Re-running is safe: every statement is ON CONFLICT DO NOTHING, so it will
-- not overwrite balances that have since moved.
--
-- Two things here are load-bearing:
--
-- 1. `slug` is an identifier, not a label. Templates carry hints like
--    account_hint='cashback_wallet', and the parser addresses accounts by slug
--    and never sees a UUID. Renaming a slug silently breaks template routing.
--    Change `name` instead — that is the display label.
--
-- 2. `opening_balance` is what makes reconciliation work (SPEC §3.3, §9.2).
--    Without it, computed balances drift from reported ones forever, and the
--    cashback wallet goes negative the first time you redeem points earned
--    before tracking began.

BEGIN;

INSERT INTO accounts
  (slug, name, institution, type, is_liability, balance_semantics, reconcilable,
   opening_balance, current_balance, balance_as_of, credit_limit,
   is_profit_bearing, sort_order)
VALUES
  -- SAIB reports no balance in ANY message (§3.3b), so reconcilable = false.
  -- These opening balances are the only anchor these accounts will ever have;
  -- everything after this is inferred from message flow alone.
  ('saib_current', 'SAIB Current', 'SAIB', 'checking', false, 'balance', false,
   0.00, 0.00, '2026-08-12', NULL, false, 1),

  ('saib_savings', 'SAIB Savings (Al Baraka)', 'SAIB', 'savings', false, 'balance', false,
   0.00, 0.00, '2026-08-12', NULL, true, 2),

  ('alrajhi_current', 'AlRajhi Current', 'AlRajhiBank', 'checking', false, 'balance', true,
   0.00, 0.00, '2026-08-12', NULL, false, 3),

  -- The printed رصيد on this card is AVAILABLE CREDIT, not debt: purchases
  -- decrease it, payments increase it. Store the reported figure here and set
  -- credit_limit; debt is derived as limit − balance.
  --
  -- Storing the reported figure as if it were debt reports the card as an
  -- asset instead of a liability — a swing of roughly the full credit limit in
  -- net worth, on one account (§3.3a).
  ('alrajhi_card', 'AlRajhi Credit Card', 'AlRajhiBank', 'credit_card', true,
   'available_credit', true, 0.00, 0.00, '2026-08-12', 0.00, false, 4),

  ('cashback_wallet', 'AlRajhi Cashback', 'AlRajhiBank', 'cashback_wallet', false,
   'balance', false, 0.00, 0.00, '2026-08-12', NULL, false, 5),

  ('barq', 'Barq Wallet', 'barq app', 'wallet', false, 'balance', true,
   0.00, 0.00, '2026-08-12', NULL, false, 6),

  -- STC Bank: real account with transfers, card purchases and Apple Pay in the
  -- samples. Seeded so the balance is right, but note there are currently ZERO
  -- STC templates — every STC message will park in the review queue until we
  -- write them. That is correct behaviour, not a failure (§10.5).
  ('stc', 'STC Bank', 'STC Bank', 'checking', false, 'balance', true,
   0.00, 0.00, '2026-08-12', NULL, false, 7)
ON CONFLICT (slug) DO NOTHING;


-- How each bank masks each account. Scoped by institution on purpose (§8.3):
-- two banks can mask different accounts to the same last digits, and matching
-- on digits alone posts your salary against someone else's card.
--
-- Masking is inconsistent even within one sender — SAIB writes the same
-- account as XXXX7001, XXX7001, X7001 and 0341xx17001 — but all of those
-- reduce to '7001' through last_digits(), so one row per account is enough.
INSERT INTO account_identifiers (account_id, institution, kind, value)
SELECT id, 'SAIB', 'account', '7001' FROM accounts WHERE slug = 'saib_current'
UNION ALL
SELECT id, 'SAIB', 'account', '7002' FROM accounts WHERE slug = 'saib_savings'
UNION ALL
SELECT id, 'AlRajhiBank', 'card', '0256' FROM accounts WHERE slug = 'alrajhi_card'
UNION ALL
-- Barq names the funding card, not the wallet, so this maps to the card.
SELECT id, 'barq app', 'card', '0256' FROM accounts WHERE slug = 'alrajhi_card'
ON CONFLICT (institution, kind, value) DO NOTHING;


-- ---------------------------------------------------------------------------
-- NOT SEEDED, deliberately
-- ---------------------------------------------------------------------------
-- STC cards *5842 and *1152 appear in the samples, and 318 / 713 appear as
-- transfer counterparties. None of them are confirmed as YOUR account, and
-- STC masks to three digits rather than four, which collides sooner.
--
-- A wrong identifier is worse than a missing one: missing means the message
-- parks in review (§8.3), wrong means it posts silently against the wrong
-- account. Nothing is lost by leaving these out — there are no STC templates
-- yet, so no STC message can parse regardless.
--
-- Uncomment once confirmed:
--
-- INSERT INTO account_identifiers (account_id, institution, kind, value)
-- SELECT id, 'STC Bank', 'card', '5842' FROM accounts WHERE slug = 'stc'
-- UNION ALL
-- SELECT id, 'STC Bank', 'card', '1152' FROM accounts WHERE slug = 'stc'
-- ON CONFLICT (institution, kind, value) DO NOTHING;
--
-- Likewise the AlRajhi current account: no message in the samples names it,
-- so its masked digits are unknown.

COMMIT;


-- Sanity check. Run after seeding to confirm the card is counted as a
-- liability rather than an asset:
--
--   net worth = assets − debt,  where card debt = credit_limit − balance
--
-- SELECT to_char(SUM(
--          CASE WHEN is_liability AND balance_semantics = 'available_credit'
--               THEN -(credit_limit - current_balance)
--               WHEN is_liability THEN -current_balance
--               ELSE current_balance END), 'FM999,999,990.00') AS net_worth
-- FROM accounts WHERE is_active;
