-- The system health panel and the backup reminder. SPEC §11.6, milestone 14.
--
-- Nothing here changes what the app means; it changes what the health panel
-- costs and gives the export reminder somewhere to remember.
--
--   1. Three indexes on `raw_messages`. The Review page is the one screen a
--      person leaves open and refreshes — it is where you watch a stuck queue
--      drain — and every figure on it is an aggregate over this table. As
--      written, the panel's six `count(*) FILTER (...)` columns were one
--      sequential scan of every message ever received, repeated on each poll.
--      That is cheap at a thousand rows and is a table that only grows.
--
--      `raw_messages_status_idx (status, received_at)` already existed for the
--      parser's claim, and it also answers the status counts and the
--      oldest-queued lookup as an index-only scan. What it cannot answer is
--      `max(received_at)` across all statuses, the parse-method mix, or the
--      LLM call count — hence these three.
--
--   2. `settings.last_export_at`. §11.6: "the raw store is the irreplaceable
--      asset, since everything else can be re-derived from it… You're on a free
--      tier that pauses on inactivity and offers no restore guarantees; treat
--      your own export as the backup." A reminder that cannot tell whether you
--      already exported is a reminder you learn to dismiss, so the moment the
--      raw dump is served is recorded, and the nightly pass raises the alert
--      only when that moment is old.
--
--      Nullable with no default on purpose: NULL means "never backed up", which
--      is a different and more urgent state than "backed up a long time ago",
--      and defaulting it to now() would silently claim a backup that does not
--      exist.

-- `max(received_at)` — "last message received", the figure the whole panel
-- exists for. DESC so the planner takes the first row of the index and stops.
CREATE INDEX IF NOT EXISTS raw_messages_received_idx
  ON raw_messages (received_at DESC);

--> statement-breakpoint

-- Template hit rate, which §11.6 says "should climb toward ~100%". Measured
-- over parsed messages only — a message that never reached a verdict has no
-- method — so the index is partial on exactly that set and stays small.
CREATE INDEX IF NOT EXISTS raw_messages_parsed_method_idx
  ON raw_messages (parse_method)
  WHERE status = 'parsed';

--> statement-breakpoint

-- LLM calls this month against the free-tier cap. Empty today — the Gemini
-- fallback is deferred past v1 (§2) — and an empty partial index costs nothing
-- to keep, which is the point: the row appears on the panel as *not enabled*
-- rather than being omitted, and the day it is enabled the count is already
-- cheap.
CREATE INDEX IF NOT EXISTS raw_messages_llm_idx
  ON raw_messages (received_at)
  WHERE parse_method = 'llm';

--> statement-breakpoint

ALTER TABLE settings ADD COLUMN IF NOT EXISTS last_export_at timestamptz;
