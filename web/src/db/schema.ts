/**
 * Database schema — SPEC.md §4.
 *
 * Drizzle owns the schema and the migrations. The Python parser service reads
 * and writes these tables with plain SQL; it deliberately does not define its
 * own models, so there is exactly one source of truth for the shape of the
 * data.
 *
 * Covers milestones 1–12 (SPEC §12).
 */

import { desc, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ enums */

export const accountType = pgEnum("account_type", [
  "checking",
  "savings",
  "credit_card",
  "loan",
  "cash",
  "wallet",
  "cashback_wallet",
]);

/** §3.3(a) — on a credit card, the reported figure is available credit, not
 *  debt. Purchases decrease it and payments increase it. Applying the wrong
 *  semantics turns a liability into an asset. */
export const balanceSemantics = pgEnum("balance_semantics", ["balance", "available_credit"]);

export const messageStatus = pgEnum("message_status", [
  "pending",
  "processing",
  "parsed",
  "ignored",
  "needs_review",
  "failed",
]);

export const ignoredReason = pgEnum("ignored_reason", [
  "otp",
  "promo",
  "declined",
  "balance_alert",
  "statement",
  "notification",
  "user",
]);

export const classification = pgEnum("classification", ["financial", "otp", "promo", "unknown"]);
export const language = pgEnum("language", ["ar", "en", "mixed"]);
export const parseMethod = pgEnum("parse_method", ["template", "llm", "manual"]);

export const templateKind = pgEnum("template_kind", [
  "purchase",
  "withdrawal",
  "transfer_in",
  "transfer_out",
  "deposit",
  "refund",
  "salary",
  "profit",
  "fee",
  "card_payment",
  "bill_payment",
  "balance_alert",
  "otp",
  "notification",
]);

export const direction = pgEnum("direction", ["debit", "credit"]);

export const transactionType = pgEnum("transaction_type", [
  "purchase",
  "withdrawal",
  "transfer",
  "card_payment",
  "loan_payment",
  "fee",
  "refund",
  "income",
  "profit",
  "bill_payment",
  /** A balance corrected by hand (§3.3b, §12.7).
   *
   *  Not money that moved — money that was already there and unaccounted for,
   *  usually on an account whose bank never states a balance. It exists as a
   *  transaction because balances are derived from the legs and nothing else:
   *  `recompute_balances` would overwrite a directly-written figure on the next
   *  tick. Always `excluded_from_analytics`; a correction is neither income nor
   *  spending, and booking it as either distorts the savings rate (§6). */
  "adjustment",
]);

/** §7.2 — a fuel pre-auth arrives before settlement. Settlement updates the
 *  pending row; it never inserts a second one. */
export const transactionState = pgEnum("transaction_state", [
  "posted",
  "pending",
  "reversed",
  "declined",
]);

export const incomeClass = pgEnum("income_class", ["earned", "passive", "other"]);
export const cardScheme = pgEnum("card_scheme", ["mada", "visa", "mastercard", "applepay"]);
export const origin = pgEnum("origin", ["parsed", "manual"]);
export const snapshotSource = pgEnum("snapshot_source", ["sms", "manual", "computed"]);

export const recurringKind = pgEnum("recurring_kind", ["subscription", "bill", "salary", "profit"]);

export const cadence = pgEnum("cadence", [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
]);

export const seriesStatus = pgEnum("series_status", ["active", "paused", "cancelled"]);

export const alertSeverity = pgEnum("alert_severity", ["info", "warning", "critical"]);

/* --------------------------------------------------------------- settings */

/**
 * §5.5 — the period anchors, in one row.
 *
 * Both anchors are configurable but read from one place; the literals 25 and 0
 * are never inlined at a call site. The SQL period functions in migration 0003
 * do hardcode them, because an IMMUTABLE function may not read a table and an
 * index on a non-immutable expression is rejected outright — so this row is
 * the source of truth for everything above SQL, and `src/lib/settings.ts` is
 * the only TypeScript module that names the values.
 *
 * Single row, enforced: `id` is fixed at 1 by a check constraint, so a second
 * settings row is a database error rather than a silent second opinion about
 * when the month starts.
 */
export const settings = pgTable(
  "settings",
  {
    id: integer("id").primaryKey().default(1),
    /** Day of month the salary cycle opens. 25 — every month has one. */
    cycleAnchorDay: integer("cycle_anchor_day").notNull().default(25),
    /** 0 = Sunday. Matches the Gulf work week; Postgres's own week is Monday. */
    weekStartDow: integer("week_start_dow").notNull().default(0),
    /** Every bucket boundary is evaluated in this zone, never UTC. */
    timezone: text("timezone").notNull().default("Asia/Riyadh"),

    /**
     * §11.6 — when the raw store was last dumped to a file you hold.
     *
     * The reminder's whole credibility rests on this column: a monthly nag that
     * cannot tell whether you already exported is one you learn to dismiss
     * without reading. Stamped by `/api/raw-messages/export`, read by the
     * nightly pass in `db/backup.ts`.
     *
     * NULL means never, which is a more urgent state than "a long time ago" and
     * is rendered as such. Defaulting it to now() would claim a backup that
     * does not exist.
     */
    lastExportAt: timestamp("last_export_at", { withTimezone: true }),
  },
  (t) => [check("settings_single_row", sql`${t.id} = 1`)],
);

/* --------------------------------------------------------------- accounts */

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  /**
   * Stable logical name: `saib_current`, `alrajhi_card`, `cashback_wallet`.
   *
   * The parser addresses accounts by slug and never sees a UUID — templates
   * carry hints like `account_hint="cashback_wallet"`, and the verification
   * suite runs with no database at all. The DB layer resolves slug → id on
   * write. Renaming a slug breaks template hints, so treat it as an identifier
   * rather than a label; `name` is the thing you're allowed to change.
   */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  institution: text("institution").notNull(),
  type: accountType("type").notNull(),
  isLiability: boolean("is_liability").notNull().default(false),
  balanceSemantics: balanceSemantics("balance_semantics").notNull().default("balance"),
  /** §3.3(b) — a capability flag, not a guarantee. SAIB never reports a
   *  balance in any message, so its accounts are unreconcilable by design. */
  reconcilable: boolean("reconcilable").notNull().default(true),

  openingBalance: numeric("opening_balance", { precision: 14, scale: 2 }).notNull().default("0"),
  currentBalance: numeric("current_balance", { precision: 14, scale: 2 }).notNull().default("0"),
  balanceAsOf: timestamp("balance_as_of", { withTimezone: true }),

  creditLimit: numeric("credit_limit", { precision: 14, scale: 2 }),
  statementDay: integer("statement_day"),
  dueDay: integer("due_day"),

  isProfitBearing: boolean("is_profit_bearing").notNull().default(false),
  profitPayoutDay: integer("profit_payout_day"),

  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** §8.3 — uniqueness is (institution, kind, value), never (kind, value).
 *  Two banks can legitimately mask different accounts to the same suffix. */
export const accountIdentifiers = pgTable(
  "account_identifiers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    institution: text("institution").notNull(),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
  },
  (t) => [unique("account_identifiers_scoped").on(t.institution, t.kind, t.value)],
);

/* ---------------------------------------------------------- raw  messages */

/** §3.1 — append-only. Never edited, never deleted.
 *  If you only persist the parsed result, every parser bug becomes permanent
 *  data loss, and early parser bugs are guaranteed. */
export const rawMessages = pgTable(
  "raw_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sender: text("sender").notNull(),
    body: text("body").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    deviceSentAt: timestamp("device_sent_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),

    bodyHash: text("body_hash").notNull().unique(),

    status: messageStatus("status").notNull().default("pending"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),

    ignoredReason: ignoredReason("ignored_reason"),
    classification: classification("classification"),
    language: language("language"),
    shapeHash: text("shape_hash"),

    templateId: uuid("template_id"),
    parseMethod: parseMethod("parse_method"),
    llmResponse: jsonb("llm_response"),
  },
  (t) => [
    // The parser tick claims work with this (SPEC §10.3). It also answers the
    // health panel's per-status counts and its oldest-queued lookup without
    // touching the heap.
    index("raw_messages_status_idx").on(t.status, t.receivedAt),
    // The review workbench groups the queue by shape (SPEC §10.7).
    index("raw_messages_shape_idx").on(t.shapeHash),
    // §11.6's health panel, which is polled: "last message received" is a
    // max() across every status, so the status index above cannot serve it.
    index("raw_messages_received_idx").on(desc(t.receivedAt)),
    // Template hit rate, over parsed messages only — a message that never
    // reached a verdict has no method to attribute.
    index("raw_messages_parsed_method_idx")
      .on(t.parseMethod)
      .where(sql`status = 'parsed'`),
    // LLM calls this month against the free-tier cap. Empty while the Gemini
    // fallback is deferred (§2), and an empty partial index costs nothing.
    index("raw_messages_llm_idx")
      .on(t.receivedAt)
      .where(sql`parse_method = 'llm'`),
  ],
);

export const smsTemplates = pgTable("sms_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  sender: text("sender").notNull(),
  shapeHash: text("shape_hash").notNull().unique(),
  language: language("language").notNull(),
  pattern: text("pattern").notNull(),
  fieldMap: jsonb("field_map").notNull(),
  kind: templateKind("kind").notNull(),
  hitCount: integer("hit_count").notNull().default(0),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  createdBy: parseMethod("created_by").notNull().default("manual"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ----------------------------------------------------- categories, people */

export const categories = pgTable("categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  icon: text("icon"),
  color: text("color"),
  isIncome: boolean("is_income").notNull().default(false),
});

export const merchants = pgTable("merchants", {
  id: uuid("id").defaultRandom().primaryKey(),
  normalizedName: text("normalized_name").notNull().unique(),
  displayName: text("display_name").notNull(),
  defaultCategoryId: uuid("default_category_id").references(() => categories.id),
});

/** §8.2 — is_owned is what makes a transfer internal. Never the name: a
 *  transfer to your own name at another bank is internal, and classifying on
 *  the recipient name books an expense that never happened. */
export const counterparties = pgTable("counterparties", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  ibanSuffix: text("iban_suffix"),
  defaultCategoryId: uuid("default_category_id").references(() => categories.id),
  isOwned: boolean("is_owned").notNull().default(false),
});

/* ------------------------------------------------------- recurring series */

/**
 * §11.3 — declared ahead of `transactions` only because the transaction row
 * carries a foreign key back to it.
 *
 * `amount_avg` and `amount_last` are both kept because a profit series has no
 * stable amount: §11.3 requires profit to be detected on *cadence only*, and
 * amount-drift warnings suppressed for `kind = 'profit'`. Storing one blended
 * figure would make that distinction impossible to draw later.
 */
export const recurringSeries = pgTable(
  "recurring_series",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    merchantId: uuid("merchant_id").references(() => merchants.id),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    kind: recurringKind("kind").notNull(),

    /**
     * What to call it on screen.
     *
     * Stored because there is no one place to derive it from: a subscription has
     * a merchant row, a SADAD bill has only a biller string (§7.5), a salary has
     * neither, and a profit payout is named after the account it lands in. The
     * detector resolves that chain once. Deriving it at read time from
     * `detect_key` puts the normalised key on screen instead — `stc` where STC
     * belongs.
     */
    label: text("label"),

    amountAvg: numeric("amount_avg", { precision: 14, scale: 2 }),
    amountLast: numeric("amount_last", { precision: 14, scale: 2 }),
    /** The amount before the last change, and the day the new one first
     *  appeared. §11.3's price-increase flag is not evidence of anything
     *  without them. Always null on a profit series — its amount varies every
     *  cycle by nature and a drift warning there fires monthly and means
     *  nothing. */
    amountPrev: numeric("amount_prev", { precision: 14, scale: 2 }),
    priceChangeAt: date("price_change_at"),
    dayOfMonth: integer("day_of_month"),
    /** Weekly and biweekly matter: they only become visible at the week grain. */
    cadence: cadence("cadence").notNull(),
    /** The median gap the detector measured, in days. `cadence` is the bucket
     *  that was rounded into; this is the measurement, and what the next
     *  expected date is derived from for weekly and biweekly series. */
    intervalDays: integer("interval_days"),

    nextExpectedAt: date("next_expected_at"),
    firstSeen: timestamp("first_seen", { withTimezone: true }),
    lastSeen: timestamp("last_seen", { withTimezone: true }),
    occurrenceCount: integer("occurrence_count").notNull().default(0),

    status: seriesStatus("status").notNull().default("active"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),

    /**
     * `merchant identity | account | kind`, built by the detector.
     *
     * Text rather than a composite key over the three columns, because two of
     * them are nullable — a SADAD bill has no merchant row, a salary has no
     * merchant at all — and UNIQUE counts NULLs as distinct. The composite
     * version would let the nightly pass insert a second copy of the same
     * series every single night.
     */
    detectKey: text("detect_key"),

    /** A person said this is real. Keeps it in the bills calendar through a
     *  missed charge that would otherwise drop its confidence. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** A person said it is noise. The row survives as a tombstone so the
     *  detector recognises the pattern and stays quiet, rather than
     *  rediscovering it under a new id tomorrow. */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    /** Stronger: the detector may not draw conclusions here at all, so even the
     *  cadence and amounts stop being updated. */
    excludedFromDetection: boolean("excluded_from_detection").notNull().default(false),
  },
  (t) => [
    unique("recurring_series_detect_key").on(t.detectKey),
    index("recurring_series_next_expected_idx").on(t.nextExpectedAt),
  ],
);

/* ----------------------------------------------------------- transactions */

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    rawMessageId: uuid("raw_message_id").references(() => rawMessages.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),

    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    direction: direction("direction").notNull(),
    type: transactionType("type").notNull(),
    state: transactionState("state").notNull().default("posted"),

    biller: text("biller"),
    billerService: text("biller_service"),
    invoiceNumber: text("invoice_number"),

    incomeClass: incomeClass("income_class"),
    /** §5.6 — an early salary carries a due date. The due date decides the
     *  cycle, not the received date, or one cycle shows double income and the
     *  next shows none. */
    cycleOverride: date("cycle_override"),

    merchantRaw: text("merchant_raw"),
    merchantId: uuid("merchant_id").references(() => merchants.id),
    categoryId: uuid("category_id").references(() => categories.id),
    description: text("description"),
    notes: text("notes"),

    /** §4 — links an occurrence back to the series that predicted it. */
    recurringSeriesId: uuid("recurring_series_id").references(() => recurringSeries.id, {
      onDelete: "set null",
    }),

    transferGroupId: uuid("transfer_group_id"),
    counterpartyAccountId: uuid("counterparty_account_id"),
    counterpartyId: uuid("counterparty_id").references(() => counterparties.id),
    isInternalTransfer: boolean("is_internal_transfer").notNull().default(false),

    /** §8.2.1 — this leg is a second institution's description of a movement
     *  already booked from another message, not a second movement.
     *
     *  A cross-bank transfer sends one SMS from each side, and each one
     *  resolves both accounts, so each books the full movement: four legs for
     *  one 113, both balances moved twice. Every leg is internal so spending
     *  stays correct — the damage lands on balances, and surfaces as a
     *  reconciliation alert against an account that looks like it lost a
     *  message when it actually processed one twice.
     *
     *  Points at the leg that was kept. The row is never deleted: the echo is
     *  real, its raw message is real, and the link is what explains why the
     *  ledger shows one movement where two messages arrived. */
    supersededBy: uuid("superseded_by"),

    reversesTransactionId: uuid("reverses_transaction_id"),
    refundsTransactionId: uuid("refunds_transaction_id"),
    refundedAmount: numeric("refunded_amount", { precision: 14, scale: 2 }),

    // FX provenance. Metadata only — every transaction settles in SAR.
    originalAmount: numeric("original_amount", { precision: 14, scale: 2 }),
    originalCurrency: text("original_currency"),
    fxRate: numeric("fx_rate", { precision: 18, scale: 8 }),
    feeAmount: numeric("fee_amount", { precision: 14, scale: 2 }),
    country: text("country"),

    cardScheme: cardScheme("card_scheme"),

    /** The masked card this leg moved through, as the sender printed it.
     *
     *  Kept because top-up linking is the one rule that spans two messages
     *  from two different institutions, and the card is what identifies them
     *  as the same money: a Barq `اضافة اموال` names the funding card, and the
     *  AlRajhi purchase that funds it names the same card. Amount and time
     *  alone are not enough to pair them — a wallet purchase of the same
     *  amount in the same minute is an ordinary occurrence, since spending the
     *  wallet is precisely what the top-up was for. */
    cardLast4: text("card_last4"),

    /** The parser's own class for this leg, before it was coarsened into
     *  `type`.
     *
     *  `_KIND_TO_TYPE` folds `wallet_topup`, `transfer_in` and
     *  `cashback_redeem` all onto `transfer`, which is right for the ledger —
     *  it does not care — but it destroys the only marker that says which
     *  transfers are top-ups. Rebuilding that from `type` plus the presence of
     *  a card would be a guess dressed as a query. */
    parserKind: text("parser_kind"),

    /** §9.4 — a field you edited by hand survives replay untouched. This is
     *  the highest-consequence guarantee in the system. */
    origin: origin("origin").notNull().default("parsed"),
    /**
     * Column names, as a JSON array: `["category_id","merchant_raw"]`.
     *
     * An array specifically, and a check constraint in migration 0008 enforces
     * it. Replay's guard is `NOT (locked_fields ? 'category_id')`, and `?` on a
     * jsonb OBJECT tests its keys — so `{"category_id": true}` would read as
     * locked to that query and as unlocked to anything checking membership,
     * which is precisely the disagreement this column exists to rule out.
     */
    lockedFields: jsonb("locked_fields").$type<string[]>(),
    matchedRuleId: uuid("matched_rule_id"),

    reportedBalance: numeric("reported_balance", { precision: 14, scale: 2 }),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    isReviewed: boolean("is_reviewed").notNull().default(false),
    excludedFromAnalytics: boolean("excluded_from_analytics").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_account_posted_idx").on(t.accountId, t.postedAt),
    index("transactions_posted_idx").on(t.postedAt),
    index("transactions_transfer_group_idx").on(t.transferGroupId),
    // The top-up linking scan: unlinked legs on a given card, by time.
    index("transactions_card_posted_idx").on(t.cardLast4, t.postedAt),
    // Idempotency: one message, one transaction.
    unique("transactions_one_per_message").on(t.rawMessageId, t.accountId, t.direction),
    check(
      "transactions_locked_fields_is_array",
      sql`${t.lockedFields} IS NULL OR jsonb_typeof(${t.lockedFields}) = 'array'`,
    ),
  ],
);

/** Σ splits must equal transactions.amount. Aggregate through
 *  v_categorized_amounts, never by summing both tables — that double-counts. */
export const transactionSplits = pgTable("transaction_splits", {
  id: uuid("id").defaultRandom().primaryKey(),
  transactionId: uuid("transaction_id")
    .notNull()
    .references(() => transactions.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => categories.id),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
});

/* ----------------------------------------------------------- account edits */

/**
 * Every hand edit to an account, as it happened.
 *
 * An account carries the two numbers the whole dashboard is built on — the
 * balance and, on a card, the limit that turns it into debt — so a screen that
 * lets you change them silently is a screen that can make net worth wrong with
 * nothing to point at afterwards. Each save writes one row here saying which
 * fields moved and from what.
 *
 * A balance change additionally books an `adjustment` transaction and links it
 * from `adjustment_transaction_id`. That leg is the part that shows up in the
 * ledger: the correction gets a date, an amount and an account like any other
 * event, and — because balances are derived from the legs — it is also the only
 * form of balance edit that survives the next parser tick.
 *
 * Not deleted when the account is renamed or retyped; that is the point.
 */
export const accountEdits = pgTable(
  "account_edits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** `{field: {from, to}}`, already rendered for display. */
    changed: jsonb("changed").notNull(),
    /** Why. Free text, and the most useful column here six months later. */
    note: text("note"),
    adjustmentTransactionId: uuid("adjustment_transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_edits_account_idx").on(t.accountId, t.createdAt)],
);

/* ------------------------------------------------ balances, statements, alerts */

export const balanceSnapshots = pgTable(
  "balance_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    balance: numeric("balance", { precision: 14, scale: 2 }).notNull(),
    source: snapshotSource("source").notNull(),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  },
  (t) => [index("balance_snapshots_account_idx").on(t.accountId, t.asOf)],
);

export const cardStatements = pgTable("card_statements", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  statementDate: date("statement_date").notNull(),
  totalDue: numeric("total_due", { precision: 14, scale: 2 }),
  minimumDue: numeric("minimum_due", { precision: 14, scale: 2 }),
  dueDate: date("due_date"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

/* ------------------------------------------------- budgets, goals, loans */

/**
 * §4, §11.2 — one amount per category per salary cycle, keyed by the 25th that
 * opens it.
 *
 * `cycle_start` is a DATE that is always a 25th, never a calendar month: a
 * `budgets.month` column would reintroduce `date_trunc('month')` through the
 * back door and silently misattribute the last week of every cycle. The check
 * constraint makes a non-25th insert fail loudly instead.
 *
 * There is deliberately no weekly budget column. §11.2 derives the weekly
 * figure by day-weighting the cycle budget — storing it would let the two
 * drift, and dividing by four understates the allowance by ~10% because a
 * cycle averages 4.43 weeks.
 */
export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    /** Underspend raises next cycle's allowance; overspend lowers it (§11.2). */
    rollover: boolean("rollover").notNull().default(false),
    cycleStart: date("cycle_start").notNull(),

    /**
     * §11.2 — the rollover carry into this cycle, signed, and **stored**.
     *
     * `effective_budget(c) = base_budget(c) + carry(c)`, where
     * `carry(c) = effective_budget(c−1) − spent(c−1)`. Written once, when the
     * previous cycle closes — never recomputed by folding over history, because
     * that fold is what makes a single corrected old transaction cascade
     * through every budget since.
     *
     * Kept separate from `amount` all the way to the screen: a 2,000 base
     * against a −1,800 carry has 200 to spend, and printing only the 200 makes
     * an emergency look like a policy.
     */
    carryIn: numeric("carry_in", { precision: 14, scale: 2 }).notNull().default("0"),
    /** Non-null means the carry is settled: the close job leaves it alone from
     *  then on, whether it runs again, a correction lands, or a replay reruns.
     *  Also set by "reset carry", which is the only way to move it by hand. */
    carryClosedAt: timestamp("carry_closed_at", { withTimezone: true }),
  },
  (t) => [
    unique("budgets_category_cycle").on(t.categoryId, t.cycleStart),
    check("budgets_cycle_start_is_anchor", sql`EXTRACT(DAY FROM ${t.cycleStart}) = 25`),
    index("budgets_cycle_idx").on(t.cycleStart),
  ],
);

/** §11.2 — a virtual bucket over a real account. Progress reads the linked
 *  account's actual balance, never a separate counter, so a withdrawal reduces
 *  progress automatically and the number cannot drift from reality. */
export const goals = pgTable(
  "goals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    targetAmount: numeric("target_amount", { precision: 14, scale: 2 }).notNull(),
    targetDate: date("target_date"),
    linkedAccountId: uuid("linked_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),

    /**
     * The size of the bucket — how much of the linked account this goal claims.
     *
     * **Not the progress.** Progress is read from the account's real balance
     * (§11.2), which is what makes a withdrawal reduce it automatically and
     * what stops the figure drifting. This is the claim, and it exists as a
     * stored number precisely because several goals may share one account and
     * §11.2 requires that the sum of their claims be checked against the
     * balance, with the unallocated remainder always displayed.
     */
    allocation: numeric("allocation", { precision: 14, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("goals_allocation_not_negative", sql`${t.allocation} >= 0`),
    check("goals_target_is_positive", sql`${t.targetAmount} > 0`),
    index("goals_account_idx").on(t.linkedAccountId),
  ],
);

/** §4 — amortization is computed from `apr` and `current_balance`, never
 *  stored. Only the interest portion of a payment is an expense; the principal
 *  moves net worth (§6). */
export const loans = pgTable("loans", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  lender: text("lender"),
  principal: numeric("principal", { precision: 14, scale: 2 }).notNull(),
  apr: numeric("apr", { precision: 6, scale: 4 }),
  termMonths: integer("term_months"),
  startDate: date("start_date"),
  paymentAmount: numeric("payment_amount", { precision: 14, scale: 2 }),
  paymentDay: integer("payment_day"),
  currentBalance: numeric("current_balance", { precision: 14, scale: 2 }).notNull().default("0"),
});

/* ------------------------------------------------------- rules and alerts */

/** §9.5 — first matching rule wins, in ascending priority. Not "apply all
 *  matching rules": that makes outcomes depend on invisible interactions
 *  between rules and is miserable to debug at 20+ rules. */
export const rules = pgTable(
  "rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    priority: integer("priority").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),
    name: text("name").notNull(),
    /** [{field, operator, value}, ...] — ANDed. */
    match: jsonb("match").notNull(),
    /** {set_category, set_merchant, mark_internal_transfer,
     *   exclude_from_analytics, set_account} */
    actions: jsonb("actions").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rules_priority_idx").on(t.enabled, t.priority)],
);

/**
 * §11.6 — in-app alerts only in v1: a badge and a dashboard banner.
 *
 * `type` is text rather than an enum on purpose. The listed types (reconciliation
 * drift, stale ingestion, budget overspend, missed salary, card due, …) are the
 * ones known today, and adding the next one should not require a migration on a
 * table whose whole job is to be written to by background jobs.
 */
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: text("type").notNull(),
    severity: alertSeverity("severity").notNull().default("info"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  },
  (t) => [index("alerts_open_idx").on(t.dismissedAt, t.createdAt)],
);

/** §3.3 — drift means a message was missed, double-counted, or misparsed.
 *  This is the feature that makes the dashboard trustworthy rather than
 *  decorative. */
export const reconciliationAlerts = pgTable("reconciliation_alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  computedBalance: numeric("computed_balance", { precision: 14, scale: 2 }).notNull(),
  reportedBalance: numeric("reported_balance", { precision: 14, scale: 2 }).notNull(),
  delta: numeric("delta", { precision: 14, scale: 2 }).notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionNote: text("resolution_note"),
});
