import { desc, inArray, sql } from "drizzle-orm";

import { getDb, schema } from "@/db";
import { timeOfDay } from "@/lib/format";
import {
  type Health,
  type ParkedMessage,
  type ShapeGroup,
  groupByShape,
  ingestionStale,
  parseRate,
} from "@/lib/review";

import { dismissGroup, restoreGroup, retryGroup } from "./actions";
import { DeriveForm } from "./derive-form";

export const dynamic = "force-dynamic";

async function load() {
  const db = getDb();

  const parked = (await db
    .select({
      id: schema.rawMessages.id,
      sender: schema.rawMessages.sender,
      body: schema.rawMessages.body,
      receivedAt: schema.rawMessages.receivedAt,
      status: schema.rawMessages.status,
      shapeHash: schema.rawMessages.shapeHash,
      lastError: schema.rawMessages.lastError,
      ignoredReason: schema.rawMessages.ignoredReason,
      attempts: schema.rawMessages.attempts,
    })
    .from(schema.rawMessages)
    .where(inArray(schema.rawMessages.status, ["needs_review", "failed"]))
    .orderBy(desc(schema.rawMessages.receivedAt))
    .limit(500)) as ParkedMessage[];

  const dismissed = (await db
    .select({
      id: schema.rawMessages.id,
      sender: schema.rawMessages.sender,
      body: schema.rawMessages.body,
      receivedAt: schema.rawMessages.receivedAt,
      status: schema.rawMessages.status,
      shapeHash: schema.rawMessages.shapeHash,
      lastError: schema.rawMessages.lastError,
      ignoredReason: schema.rawMessages.ignoredReason,
      attempts: schema.rawMessages.attempts,
    })
    .from(schema.rawMessages)
    .where(sql`${schema.rawMessages.ignoredReason} = 'user'`)
    .orderBy(desc(schema.rawMessages.receivedAt))
    .limit(200)) as ParkedMessage[];

  // `lastReceived` is formatted to an explicit UTC ISO-8601 string rather than
  // selected as a timestamptz. Drizzle only applies its column mappers to
  // columns it knows; the result of a raw `sql` fragment is passed through as
  // the driver produced it, and postgres-js hands back a string for an
  // aggregate it cannot type. Declaring it `sql<Date>` did not make it one —
  // it only moved the failure to runtime, where ingestionStale() called
  // .getTime() on a string and took the whole page down.
  const [counts] = await db
    .select({
      lastReceived: sql<
        string | null
      >`to_char(max(${schema.rawMessages.receivedAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
      pending: sql<number>`count(*) filter (where ${schema.rawMessages.status} = 'pending')::int`,
      parsed: sql<number>`count(*) filter (where ${schema.rawMessages.status} = 'parsed')::int`,
      ignored: sql<number>`count(*) filter (where ${schema.rawMessages.status} = 'ignored')::int`,
      needsReview: sql<number>`count(*) filter (where ${schema.rawMessages.status} = 'needs_review')::int`,
      failed: sql<number>`count(*) filter (where ${schema.rawMessages.status} = 'failed')::int`,
    })
    .from(schema.rawMessages);

  const accounts = await db
    .select({ slug: schema.accounts.slug, name: schema.accounts.name })
    .from(schema.accounts)
    .orderBy(schema.accounts.sortOrder);

  const health: Health = {
    lastReceived: counts?.lastReceived ? new Date(counts.lastReceived) : null,
    pending: Number(counts?.pending ?? 0),
    parsed: Number(counts?.parsed ?? 0),
    ignored: Number(counts?.ignored ?? 0),
    needsReview: Number(counts?.needsReview ?? 0),
    failed: Number(counts?.failed ?? 0),
  };

  return { parked, dismissed, accounts, health };
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-lg bg-black/[0.03] p-3 dark:bg-white/[0.06]">
      <p className="text-xs opacity-60">{label}</p>
      <p
        className={`tabular mt-0.5 text-lg font-medium ${
          tone === "warn" ? "text-amber-600 dark:text-amber-400" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function GroupCard({
  group,
  accounts,
  dismissed,
}: {
  group: ShapeGroup;
  accounts: { slug: string; name: string }[];
  dismissed?: boolean;
}) {
  const retry = retryGroup.bind(null, group.ids);
  const dismiss = dismissGroup.bind(null, group.ids);
  const restore = restoreGroup.bind(null, group.ids);

  return (
    <section className="rounded-xl border border-black/10 dark:border-white/15">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-black/10 px-4 py-2.5 dark:border-white/10">
        <div className="min-w-0">
          <p className="font-medium">
            {group.sender}
            {group.count > 1 && (
              <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-xs font-normal dark:bg-white/10">
                {group.count} messages
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs opacity-60">{group.reason}</p>
        </div>
        <p className="text-xs opacity-50">
          {group.count > 1
            ? `${timeOfDay(group.oldest)} – ${timeOfDay(group.newest)}`
            : timeOfDay(group.newest)}
        </p>
      </header>

      <div className="px-4 py-3">
        {/* Raw body verbatim. .sms-body isolates the bidi run so a right-to-left
            message cannot reorder the UI around it, and pre-wrap keeps the
            line structure the templates are written against. */}
        <pre className="sms-body overflow-x-auto rounded-lg bg-black/[0.03] p-3 text-xs leading-relaxed dark:bg-white/[0.06]">
          {group.sample.body}
        </pre>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {dismissed ? (
            <form action={restore}>
              <button
                type="submit"
                className="rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
              >
                Put back in the queue
              </button>
            </form>
          ) : (
            <>
              <form action={retry}>
                <button
                  type="submit"
                  className="rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
                >
                  Retry {group.count > 1 ? `all ${group.count}` : ""}
                </button>
              </form>
              <DeriveForm messageId={group.sample.id} accounts={accounts} />
              <form action={dismiss}>
                <button
                  type="submit"
                  className="rounded-lg px-3 py-1.5 text-sm opacity-70 hover:bg-black/5 dark:hover:bg-white/10"
                >
                  Not a transaction
                </button>
              </form>
            </>
          )}

          {group.shapeHash && (
            <code className="ml-auto text-[11px] opacity-40">{group.shapeHash}</code>
          )}
        </div>
      </div>
    </section>
  );
}

export default async function ReviewPage() {
  let data: Awaited<ReturnType<typeof load>>;

  try {
    data = await load();
  } catch (err) {
    return (
      <main>
        <h1 className="text-xl font-semibold">Review</h1>
        <p className="mt-4 text-sm opacity-70">
          {err instanceof Error ? err.message : String(err)}
        </p>
      </main>
    );
  }

  const groups = groupByShape(data.parked);
  const dismissedGroups = groupByShape(data.dismissed);
  const rate = parseRate(data.health);
  const stale = ingestionStale(data.health.lastReceived);

  return (
    <main>
      <h1 className="text-xl font-semibold">Review</h1>

      {/* §11.6 — the honest counterpart to a dashboard that claims to know your
          finances. If ingestion dies, this is where you find out. */}
      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="Last message"
          value={data.health.lastReceived ? timeOfDay(data.health.lastReceived) : "never"}
          tone={stale ? "warn" : undefined}
        />
        <Stat label="Parsed" value={String(data.health.parsed)} />
        <Stat
          label="Waiting on you"
          value={String(data.health.needsReview + data.health.failed)}
          tone={data.health.needsReview + data.health.failed > 0 ? "warn" : undefined}
        />
        <Stat
          label="Parse rate"
          value={rate === null ? "—" : `${Math.round(rate * 100)}%`}
        />
      </div>

      {stale && (
        <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          No message in over 24 hours. iOS message automations fail silently — check the
          Shortcut is still enabled.
        </p>
      )}

      <div className="mt-6 space-y-4">
        {groups.length === 0 ? (
          <div className="rounded-xl border border-black/10 p-8 text-center dark:border-white/15">
            <p className="font-medium">Nothing waiting</p>
            <p className="mt-2 text-sm opacity-70">
              Every message either parsed or was correctly ignored.
            </p>
          </div>
        ) : (
          groups.map((g) => <GroupCard key={g.key} group={g} accounts={data.accounts} />)
        )}
      </div>

      {dismissedGroups.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold tracking-wide uppercase opacity-70">
            Dismissed by you
          </h2>
          <p className="mt-1 text-xs opacity-50">
            Kept, never deleted — raw messages are append-only, so a mistake here is always
            recoverable.
          </p>
          <div className="mt-3 space-y-4">
            {dismissedGroups.map((g) => (
              <GroupCard key={g.key} group={g} accounts={data.accounts} dismissed />
            ))}
          </div>
        </section>
      )}

      <p className="mt-8 text-xs opacity-50">
        &ldquo;Teach the parser&rdquo; turns one message into a template and reparses every
        message sharing its format. Note that a format with different merchant names produces
        different groups — free text is not generalised in the shape hash.
      </p>
    </main>
  );
}
