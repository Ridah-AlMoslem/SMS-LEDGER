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

  -- STC Bank: transfers, Qatta pools, card purchases and Apple Pay. Eight
  -- templates (ST-01..ST-08). It reports a balance on the FX purchase template
  -- only, so reconciliation here is real but sparse.
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
-- The AlRajhi CURRENT account. Only one format ever names it — the incoming
-- transfer `لـ0824` — every other AlRajhi message names the card instead.
-- Taken from the message text, not the description alongside it, which said
-- 0842.
SELECT id, 'AlRajhiBank', 'account', '0824' FROM accounts WHERE slug = 'alrajhi_current'
UNION ALL
-- Barq names the funding card, not the wallet, so this maps to the card.
SELECT id, 'barq app', 'card', '0256' FROM accounts WHERE slug = 'alrajhi_card'
UNION ALL
-- Barq names the DESTINATION when you send money to your SAIB current account
-- (`لحساب7001`, bank `INVESTMENT BANK`). Without this row the transfer looks
-- like money leaving for a stranger and is counted as spending; with it, the
-- pipeline books both legs and net worth correctly does not move (§8.2).
-- The recipient name on that message is your own, which is exactly why the
-- ACCOUNT is what decides and the name is ignored.
SELECT id, 'barq app', 'account', '7001' FROM accounts WHERE slug = 'saib_current'
ON CONFLICT (institution, kind, value) DO NOTHING;


-- STC cards. Confirmed owned: both appear as the SOURCE card on purchases
-- from the STC Bank sender (`بطاقة:*5842`, Apple Pay `من:*1152`).
INSERT INTO account_identifiers (account_id, institution, kind, value)
SELECT id, 'STC Bank', 'card', '5842' FROM accounts WHERE slug = 'stc'
UNION ALL
SELECT id, 'STC Bank', 'card', '1152' FROM accounts WHERE slug = 'stc'
ON CONFLICT (institution, kind, value) DO NOTHING;


-- ---------------------------------------------------------------------------
-- NOT SEEDED, deliberately
-- ---------------------------------------------------------------------------
-- STC's 318 and 713 are OTHER PEOPLE's accounts — they appear as transfer
-- counterparties, never as the account being debited. Seeding them would make
-- someone else's account resolve to yours.
--
-- *692 is an ANB account in a Sarie transfer that carries your own name. If
-- that account is in fact yours, adding it here reclassifies those transfers
-- from external credits to internal moves — which changes your income figures,
-- so confirm before adding it.
--
-- Note STC masks to THREE digits where every other sender uses four, so the
-- collision space is a thousand rather than ten thousand. A wrong identifier
-- is worse than a missing one: missing parks the message in review (§8.3),
-- wrong posts it silently against the wrong account.

--
-- TWO OPEN QUESTIONS, both worth money:
--
-- 1. ANB. Two messages receive money from an account in YOUR name at ANB —
--    SAIB `XXXX0018 / RIDAH AL MOSLEM` and STC `*692 / RIDAH MOSLEM`. If those
--    are your accounts, add them and the transfers become internal moves; today
--    they count as money arriving from outside. Different last-4, so possibly
--    two ANB accounts:
--
--    SELECT id, 'SAIB', 'account', '0018' FROM accounts WHERE slug = 'anb_current'
--
--    (needs an `anb_current` account row first).
--
-- 2. Barq's account number as SAIB sees it. SAIB sends to
--    `BARQ SAFE AND DEPOSIT CLIENT MONEY` account `X1625`, and Barq's own
--    purchase messages cite `حساب:**1625`. If 1625 is your wallet rather than
--    Barq's pooled client account, that 4,534.07 transfer is a move into your
--    own wallet, not spending:
--
--    SELECT id, 'SAIB', 'account', '1625' FROM accounts WHERE slug = 'barq'
--
--    Left out until confirmed. A missing identifier overstates expense, which
--    is visible and correctable; a wrong one hides real spending, which is not.

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
