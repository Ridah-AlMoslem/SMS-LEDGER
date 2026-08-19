/**
 * Review queue grouping (SPEC §10.7).
 *
 * Failures arrive in format-shaped clusters, not one at a time: a bank ships
 * one new message layout and you get forty of them. So the queue groups by
 * shape hash rather than listing messages, and every action applies to a whole
 * group — hand-process one, resolve the rest.
 *
 * Kept pure and separate from the page so the grouping can be tested without a
 * database or a browser.
 */

export type ParkedMessage = {
  id: string;
  sender: string;
  body: string;
  receivedAt: Date;
  status: string;
  shapeHash: string | null;
  lastError: string | null;
  ignoredReason: string | null;
  attempts: number;
};

export type ShapeGroup = {
  /** Stable key for the group, safe to use in a form submission. */
  key: string;
  shapeHash: string | null;
  sender: string;
  status: string;
  reason: string;
  count: number;
  /** Most recent message in the group, shown as the example. */
  sample: ParkedMessage;
  newest: Date;
  oldest: Date;
  ids: string[];
};

/** Why a whole group is parked. Messages sharing a shape share a cause. */
function reasonOf(m: ParkedMessage): string {
  if (m.status === "failed") return m.lastError ?? "crashed while parsing";
  if (m.ignoredReason) return `ignored as ${m.ignoredReason}`;
  return m.lastError ?? "no template matched";
}

/**
 * Group by (shapeHash, sender, status).
 *
 * Sender is part of the key even though shape usually implies it: two banks
 * can send structurally identical messages, and merging them would offer a
 * single "retry" across senders whose templates are unrelated.
 *
 * Messages with no shape hash — parked before hashing, or hashed to null by an
 * older build — fall back to their own id so they stay visible individually
 * rather than collapsing into one meaningless bucket.
 */
export function groupByShape(messages: ParkedMessage[]): ShapeGroup[] {
  const buckets = new Map<string, ParkedMessage[]>();

  for (const m of messages) {
    const key = `${m.shapeHash ?? `id:${m.id}`}|${m.sender}|${m.status}`;
    const existing = buckets.get(key);
    if (existing) existing.push(m);
    else buckets.set(key, [m]);
  }

  return [...buckets.entries()]
    .map(([key, items]) => {
      const sorted = [...items].sort(
        (a, b) => b.receivedAt.getTime() - a.receivedAt.getTime(),
      );
      const sample = sorted[0];
      return {
        key,
        shapeHash: sample.shapeHash,
        sender: sample.sender,
        status: sample.status,
        reason: reasonOf(sample),
        count: sorted.length,
        sample,
        newest: sorted[0].receivedAt,
        oldest: sorted[sorted.length - 1].receivedAt,
        ids: sorted.map((m) => m.id),
      };
    })
    // Biggest clusters first — that is where one fix buys the most.
    .sort((a, b) => b.count - a.count || b.newest.getTime() - a.newest.getTime());
}

export type Health = {
  lastReceived: Date | null;
  pending: number;
  /** Claimed by a tick and not yet finished. Normally zero between ticks. */
  processing: number;
  /** Arrival time of the oldest message still waiting to be parsed. */
  oldestQueued: Date | null;
  parsed: number;
  ignored: number;
  needsReview: number;
  failed: number;
  /**
   * How the parsed messages were parsed — §11.6's template hit rate.
   *
   * Counted over `status = 'parsed'` alone, which is the whole subtlety: a
   * message that never reached a verdict has no method to attribute, and
   * folding the parked queue into the denominator would make the rate fall
   * when the parser meets a new format and rise when you give up on one. It is
   * a measure of how the parser succeeds, not of how often it does.
   */
  byMethod: ParseMethodCounts;
  /** LLM calls in the current calendar month, against §2's free-tier cap. */
  llmThisMonth: number;
};

export type ParseMethodCounts = {
  /** A stored regex matched the shape. This is the one that should dominate. */
  template: number;
  /** Gemini fell back on it. Deferred past v1 (§2), so zero today. */
  llm: number;
  /** Hand-parsed in this workbench (§10.7). */
  manual: number;
  /**
   * Parsed before `parse_method` was recorded, or by a path that did not set
   * it. Kept as its own figure rather than folded into `template`: a hit rate
   * that quietly counts unknowns as hits is a hit rate that only goes up.
   */
  unattributed: number;
};

export const NO_METHODS: ParseMethodCounts = {
  template: 0,
  llm: 0,
  manual: 0,
  unattributed: 0,
};

/**
 * §2 — "Google cut free Gemini quotas 50–80% in Dec 2025. The current 15 RPM /
 * 1,000 req-per-day figure is post-cut. Do not design near the ceiling."
 *
 * The daily figure is the real ceiling; a monthly budget is the useful frame
 * for "am I about to start paying", so the panel shows both and derives one
 * from the other rather than storing a second number that can disagree.
 */
export const LLM_DAILY_CAP = 1_000;

/** The month's budget at the daily cap, for a month of `days` days. */
export const llmMonthlyCap = (days: number): number => LLM_DAILY_CAP * days;

export type LlmStatus = {
  /** False while the Gemini fallback is deferred (§2) — nothing calls it. */
  enabled: boolean;
  calls: number;
  cap: number;
  /** 0–1 against the monthly budget. null when nothing is enabled to measure. */
  share: number | null;
  note: string;
};

/**
 * The LLM row, shown as *not yet enabled* rather than omitted.
 *
 * §11.6 asks for "LLM calls this month against the free-tier cap". The fallback
 * is deferred past v1 (§2), so the honest rendering is a row that says so: a
 * missing row reads as a feature nobody thought about, and the day the fallback
 * is switched on the panel must already have somewhere to put the number. The
 * count is measured either way, so an unexpected call cannot happen unseen.
 */
export function llmStatus(calls: number, monthDays: number): LlmStatus {
  const cap = llmMonthlyCap(monthDays);
  const enabled = calls > 0;

  return {
    enabled,
    calls,
    cap,
    share: enabled ? calls / cap : null,
    note: enabled
      ? `${calls} of roughly ${cap.toLocaleString("en-US")} free calls this month.`
      : "Not enabled — every format is covered by a template, and an unknown one parks in the queue below instead (§2).",
  };
}

/**
 * Share of parsed messages a stored template handled — §11.6's "should climb
 * toward ~100%".
 *
 * Over parsed messages ONLY. The denominator is deliberately not the whole
 * table: counting parked messages would conflate two different questions, and
 * the parked ones are already the queue below. What this measures is whether
 * hand-parsing is compounding into templates the way §10.7 promises — one
 * message processed by hand should turn into forty parsed by regex — so a
 * manual parse counts against the rate rather than for it.
 *
 * Returns null when nothing has parsed, rather than a misleading 100%.
 */
export function templateHitRate(h: Health): number | null {
  const m = h.byMethod;
  const attributed = m.template + m.llm + m.manual + m.unattributed;
  return attributed === 0 ? null : m.template / attributed;
}

/**
 * Share of ledger-relevant messages that parsed.
 *
 * Ignored messages are excluded from both sides on purpose: an OTP that was
 * correctly discarded is a success, and counting it as one would let a flood
 * of promotional junk inflate the rate while real failures pile up unnoticed.
 * Returns null when there is nothing to judge, rather than a misleading 100%.
 */
export function parseRate(h: Health): number | null {
  const attempted = h.parsed + h.needsReview + h.failed;
  return attempted === 0 ? null : h.parsed / attempted;
}

/**
 * Ingestion silently dying is the failure mode this whole panel exists for:
 * the pipeline depends on an iOS automation staying enabled, and it will not.
 */
export function ingestionStale(lastReceived: Date | null, now = new Date()): boolean {
  if (!lastReceived) return false;
  return now.getTime() - lastReceived.getTime() > 24 * 60 * 60 * 1000;
}

/**
 * The tick runs every minute, so anything queued longer than this is not
 * backlog — it is a tick that has stopped draining. Fifteen minutes rather than
 * two: pg_net is fire-and-forget and a cold function genuinely takes a while,
 * and an alarm that cries wolf gets ignored, which is worse than no alarm.
 */
export const QUEUE_STALL_MS = 15 * 60 * 1000;

/**
 * Parsing silently dying — the same class of failure as ingestion dying, which
 * until now had no indicator at all.
 *
 * `pending` and `processing` are the only statuses that appear in NO list on
 * this page: the queue below shows `needs_review` and `failed`, and the ledger
 * shows `parsed`. So a message that arrived and was never drained is invisible
 * everywhere — not processed, not in the review queue — while every tile above
 * still reads healthy, because `parseRate` judges only messages that reached a
 * verdict. A dead pg_cron job, a `CRON_SECRET` mismatch (the endpoint answers
 * 401 and `cron.job_run_details` still reports success) and an unhandled error
 * inside the tick all look identical from here: like nothing happened.
 */
export function parsingStalled(oldestQueued: Date | null, now = new Date()): boolean {
  if (!oldestQueued) return false;
  return now.getTime() - oldestQueued.getTime() > QUEUE_STALL_MS;
}
