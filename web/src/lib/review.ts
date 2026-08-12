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
  parsed: number;
  ignored: number;
  needsReview: number;
  failed: number;
};

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
