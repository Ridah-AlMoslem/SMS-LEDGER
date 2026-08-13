-- Close PostgREST access to the ledger. SPEC §12 milestone 1 ("RLS policies").
--
-- What this fixes, found by auditing the live database:
--
--   Supabase serves every table in `public` over PostgREST at
--   https://<ref>.supabase.co/rest/v1/, and grants the `anon` and
--   `authenticated` roles SELECT, INSERT, UPDATE, DELETE **and TRUNCATE** on
--   every table it creates. Row-level security was off everywhere, so those
--   grants were the only thing standing between the anon key and the data.
--
--   The anon key is a public value — it ships in client bundles by design.
--   That made the whole ledger world-readable and, worse, world-deletable,
--   including `raw_messages`, which §3.1 calls the irreplaceable asset: every
--   other table can be re-derived from it, and it cannot be re-derived from
--   anything.
--
-- Why this costs nothing: the app and the parser both connect as `postgres`,
-- which owns these tables and has BYPASSRLS. Nothing in this repository uses
-- supabase-js or PostgREST — @supabase/supabase-js is an unused dependency and
-- NEXT_PUBLIC_SUPABASE_URL is empty. So the entire PostgREST surface is
-- attack surface with no corresponding feature.
--
-- If a browser client is ever wanted, re-grant deliberately and write real
-- policies at the same time. Do not simply disable RLS to make it work.
--
-- Every statement is idempotent and guards on the roles existing, so this also
-- applies cleanly to a plain Postgres (PGlite, in the test harness) where
-- `anon` and `authenticated` are Supabase inventions that do not exist.

--> statement-breakpoint

-- RLS with no policies denies everything to everyone except the owner. That is
-- the correct default for a single-user ledger: access is granted by a
-- connection string held on the server, not by a policy.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

--> statement-breakpoint

-- A view is NOT covered by RLS on its base tables. By default a view runs with
-- its owner's privileges, so `v_categorized_amounts` would have handed out
-- every transaction even with the tables locked — the single easiest way to
-- believe this migration worked when it had not. security_invoker makes the
-- view evaluate under the caller's rights instead.
ALTER VIEW v_categorized_amounts SET (security_invoker = on);

--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    -- Functions are reachable too: PostgREST exposes them as RPC, and
    -- `sms_ledger_tick` drives the parser. Leaving EXECUTE to anon means
    -- anyone can run the pipeline on demand.
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
    -- Without this, the NEXT table created by `postgres` is world-writable
    -- again and the fix silently rots at the next migration.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM authenticated;
  END IF;
END $$;
