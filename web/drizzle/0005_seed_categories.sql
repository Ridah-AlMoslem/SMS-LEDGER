-- Seed the category tree. SPEC §12, milestone 1 ("seed categories").
--
-- A migration rather than a seed script because these are reference data that
-- other rows point at: `budgets.category_id` is NOT NULL, rules set a category
-- by id, and merchants carry a default one. Reference data that foreign keys
-- depend on has to exist everywhere the schema exists — including the PGlite
-- database the test suite builds from scratch — or the schema is only half
-- installed.
--
-- The ids are fixed and written out rather than generated, for the same
-- reason: a rule that says "Starbucks → Coffee" has to mean the same thing
-- after a rebuild. gen_random_uuid() here would make every environment's
-- categories mutually unintelligible.
--
-- Deliberately NOT seeded: an "Uncategorized" row. §11.2 makes uncategorized a
-- first-class thing to display, and `v_categorized_amounts` already represents
-- it as `category_id IS NULL`. A real row would compete with that NULL and
-- split the same concept across two representations, so half the queries would
-- find one and half the other.
--
-- Two levels only. A deeper tree is a taxonomy nobody maintains; if a child
-- needs splitting, split it then.

--> statement-breakpoint

INSERT INTO categories (id, parent_id, name, icon, color, is_income) VALUES
  -- Income. §6 splits this further by income_class (earned / passive / other)
  -- on the transaction, not here — the same "Salary" category is correct for
  -- both a normal month and an early payday.
  ('c0000000-0000-4000-a000-000000000001', NULL, 'Income',          '💰', '#10b981', true),
  ('c0000000-0000-4000-a000-000000000101', 'c0000000-0000-4000-a000-000000000001', 'Salary',        '🏦', '#10b981', true),
  ('c0000000-0000-4000-a000-000000000102', 'c0000000-0000-4000-a000-000000000001', 'Profit',        '📈', '#10b981', true),
  ('c0000000-0000-4000-a000-000000000103', 'c0000000-0000-4000-a000-000000000001', 'Cashback',      '🎁', '#10b981', true),
  ('c0000000-0000-4000-a000-000000000104', 'c0000000-0000-4000-a000-000000000001', 'Other income',  '✨', '#10b981', true),

  ('c0000000-0000-4000-a000-000000000002', NULL, 'Food & drink',    '🍽️', '#f59e0b', false),
  ('c0000000-0000-4000-a000-000000000201', 'c0000000-0000-4000-a000-000000000002', 'Groceries',     '🛒', '#f59e0b', false),
  ('c0000000-0000-4000-a000-000000000202', 'c0000000-0000-4000-a000-000000000002', 'Restaurants',   '🍔', '#f59e0b', false),
  ('c0000000-0000-4000-a000-000000000203', 'c0000000-0000-4000-a000-000000000002', 'Coffee',        '☕', '#f59e0b', false),
  ('c0000000-0000-4000-a000-000000000204', 'c0000000-0000-4000-a000-000000000002', 'Delivery',      '🛵', '#f59e0b', false),

  ('c0000000-0000-4000-a000-000000000003', NULL, 'Transport',       '🚗', '#3b82f6', false),
  ('c0000000-0000-4000-a000-000000000301', 'c0000000-0000-4000-a000-000000000003', 'Fuel',          '⛽', '#3b82f6', false),
  ('c0000000-0000-4000-a000-000000000302', 'c0000000-0000-4000-a000-000000000003', 'Ride hailing',  '🚕', '#3b82f6', false),
  ('c0000000-0000-4000-a000-000000000303', 'c0000000-0000-4000-a000-000000000003', 'Car & maintenance', '🔧', '#3b82f6', false),
  ('c0000000-0000-4000-a000-000000000304', 'c0000000-0000-4000-a000-000000000003', 'Parking & tolls',   '🅿️', '#3b82f6', false),

  ('c0000000-0000-4000-a000-000000000004', NULL, 'Home & bills',    '🏠', '#8b5cf6', false),
  ('c0000000-0000-4000-a000-000000000401', 'c0000000-0000-4000-a000-000000000004', 'Rent',          '🔑', '#8b5cf6', false),
  ('c0000000-0000-4000-a000-000000000402', 'c0000000-0000-4000-a000-000000000004', 'Utilities',     '💡', '#8b5cf6', false),
  -- SADAD bill payments (§7.5) land here by default; the biller field on the
  -- transaction is what distinguishes them.
  ('c0000000-0000-4000-a000-000000000403', 'c0000000-0000-4000-a000-000000000004', 'Internet & mobile', '📶', '#8b5cf6', false),
  ('c0000000-0000-4000-a000-000000000404', 'c0000000-0000-4000-a000-000000000004', 'Household',     '🧹', '#8b5cf6', false),

  ('c0000000-0000-4000-a000-000000000005', NULL, 'Shopping',        '🛍️', '#ec4899', false),
  ('c0000000-0000-4000-a000-000000000501', 'c0000000-0000-4000-a000-000000000005', 'Clothing',      '👕', '#ec4899', false),
  ('c0000000-0000-4000-a000-000000000502', 'c0000000-0000-4000-a000-000000000005', 'Electronics',   '💻', '#ec4899', false),
  ('c0000000-0000-4000-a000-000000000503', 'c0000000-0000-4000-a000-000000000005', 'General',       '📦', '#ec4899', false),

  ('c0000000-0000-4000-a000-000000000006', NULL, 'Health',          '🩺', '#ef4444', false),
  ('c0000000-0000-4000-a000-000000000601', 'c0000000-0000-4000-a000-000000000006', 'Pharmacy',      '💊', '#ef4444', false),
  ('c0000000-0000-4000-a000-000000000602', 'c0000000-0000-4000-a000-000000000006', 'Medical',       '🏥', '#ef4444', false),

  ('c0000000-0000-4000-a000-000000000007', NULL, 'Entertainment',   '🎬', '#06b6d4', false),
  -- §11.3 flags silent annual price bumps on these; keeping subscriptions
  -- separate from one-off outings is what makes that visible.
  ('c0000000-0000-4000-a000-000000000701', 'c0000000-0000-4000-a000-000000000007', 'Subscriptions', '🔁', '#06b6d4', false),
  ('c0000000-0000-4000-a000-000000000702', 'c0000000-0000-4000-a000-000000000007', 'Going out',     '🎟️', '#06b6d4', false),

  ('c0000000-0000-4000-a000-000000000008', NULL, 'Family & gifts',  '🎀', '#f43f5e', false),
  ('c0000000-0000-4000-a000-000000000009', NULL, 'Travel',          '✈️', '#0ea5e9', false),
  ('c0000000-0000-4000-a000-00000000000a', NULL, 'Education',       '📚', '#6366f1', false),

  ('c0000000-0000-4000-a000-00000000000b', NULL, 'Financial',       '🧾', '#64748b', false),
  -- Bank fees (§7.4). An expense like any other, but worth seeing separately:
  -- it is the category you can most often eliminate outright.
  ('c0000000-0000-4000-a000-000000000b01', 'c0000000-0000-4000-a000-00000000000b', 'Fees & charges', '💸', '#64748b', false),
  ('c0000000-0000-4000-a000-000000000b02', 'c0000000-0000-4000-a000-00000000000b', 'Charity & zakat', '🤲', '#64748b', false)
ON CONFLICT (id) DO NOTHING;
