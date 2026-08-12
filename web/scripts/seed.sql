-- Seed your accounts. Run once, after the migration.
--
--   psql "$DIRECT_URL" -f web/scripts/seed.sql
--
-- Edit the values before running. Two things here are load-bearing:
--
-- 1. `slug` is an identifier, not a label. Templates carry hints like
--    account_hint='cashback_wallet', and the parser addresses accounts by slug
--    and never sees a UUID. Renaming a slug silently breaks template routing.
--    Change `name` instead — that is the display label.
--
-- 2. `opening_balance` is what makes reconciliation work (SPEC §3.3, §9.2).
--    Without it, computed balances drift from reported ones forever, and the
--    cashback wallet goes negative the first time you redeem points earned
--    before tracking began. Put in the real figure as of `balance_as_of`.

BEGIN;

INSERT INTO accounts
  (slug, name, institution, type, is_liability, balance_semantics, reconcilable,
   opening_balance, current_balance, balance_as_of, credit_limit, is_profit_bearing)
VALUES
  -- SAIB reports no balance in any message, so reconcilable = false. Its
  -- opening balance is the only anchor these accounts will ever have.
  ('saib_current', 'SAIB Current', 'SAIB', 'checking', false, 'balance', false,
   0.00, 0.00, now(), NULL, false),

  ('saib_savings', 'SAIB Savings (Al Baraka)', 'SAIB', 'savings', false, 'balance', false,
   0.00, 0.00, now(), NULL, true),

  -- On the card, the printed رصيد is AVAILABLE CREDIT, not debt. Purchases
  -- decrease it, payments increase it. Getting this backwards turns a
  -- liability into an asset and moves net worth by twice the balance.
  ('alrajhi_card', 'AlRajhi Credit Card', 'AlRajhiBank', 'credit_card', true,
   'available_credit', true, 0.00, 0.00, now(), 14000.00, false),

  ('barq', 'Barq Wallet', 'barq app', 'wallet', false, 'balance', true,
   0.00, 0.00, now(), NULL, false),

  ('cashback_wallet', 'AlRajhi Cashback', 'AlRajhiBank', 'cashback_wallet', false,
   'balance', false, 0.00, 0.00, now(), NULL, false)
ON CONFLICT (slug) DO NOTHING;

-- How each bank masks each account. Scoped by institution on purpose (§8.3):
-- two banks can mask different accounts to the same last four digits, and
-- matching on digits alone posts your salary against someone else's card.
-- Add every spelling you see — XXXX7001, XXX7001, X7001 all reduce to '7001'
-- via last_digits(), so one row per real account per institution is enough.
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

COMMIT;
