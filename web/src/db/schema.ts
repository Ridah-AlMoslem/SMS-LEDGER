/**
 * Database schema — SPEC.md §4.
 *
 * Drizzle owns the schema and the migrations. The Python parser service reads
 * and writes these tables with plain SQL; it deliberately does not define its
 * own models, so there is exactly one source of truth for the shape of the
 * data.
 *
 * Covers milestones 1–7 (SPEC §12). Budgets, goals, recurring series, loans
 * and rules are specced in §4 but not created here — they are milestones
 * 10–12 and nothing upstream depends on them.
 */

import {
  boolean,
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

/* --------------------------------------------------------------- accounts */

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
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
    // The parser tick claims work with this (SPEC §10.3).
    index("raw_messages_status_idx").on(t.status, t.receivedAt),
    // The review workbench groups the queue by shape (SPEC §10.7).
    index("raw_messages_shape_idx").on(t.shapeHash),
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

    transferGroupId: uuid("transfer_group_id"),
    counterpartyAccountId: uuid("counterparty_account_id"),
    counterpartyId: uuid("counterparty_id").references(() => counterparties.id),
    isInternalTransfer: boolean("is_internal_transfer").notNull().default(false),

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

    /** §9.4 — a field you edited by hand survives replay untouched. This is
     *  the highest-consequence guarantee in the system. */
    origin: origin("origin").notNull().default("parsed"),
    lockedFields: jsonb("locked_fields"),
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
    // Idempotency: one message, one transaction.
    unique("transactions_one_per_message").on(t.rawMessageId, t.accountId, t.direction),
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
