/**
 * SPEC §6, as SQL text — the single definition of what counts.
 *
 * These are plain strings rather than drizzle fragments for one reason: the
 * verification scripts run raw SQL against PGlite with no `@/` alias and no
 * database client, and a test that retypes the predicate it is checking is a
 * test that agrees with the bug. `scripts/verify-home-aggregates.mjs` imports
 * this file and pastes these exact clauses into its queries, so a rule that
 * changes here changes in the test at the same moment.
 *
 * `db/aggregates.ts` wraps each one in `sql.raw()` for application queries.
 * Nothing here interpolates a value, and nothing here may start doing so —
 * these are fixed clauses, and `sql.raw` on a string with a parameter in it is
 * how an injection gets written.
 *
 * Every clause is written against `v_categorized_amounts` with no table alias,
 * so a query that joins another table must apply them inside a CTE or subquery
 * over the view alone. `transactions` carries columns of the same names, and an
 * ambiguous `direction` is a query that does not run — which is the good case.
 */

/** Neither an internal transfer nor something the ledger was told to ignore. */
const OWNED_MONEY_MOVING = `NOT is_internal_transfer AND NOT excluded_from_analytics`;

/**
 * §6 — what actually left.
 *
 * Excludes internal transfers (moving your own money is not spending), card
 * payments (the purchase was already counted; counting both inflates spending
 * by up to 2×) and loan payments (only the interest is expense, and it arrives
 * as its own leg — the principal moves net worth). Declined authorisations
 * never happened.
 *
 * Drop any one clause and §6's worked example reports 7,600 instead of 1,100 —
 * a 6.9× overstatement that looks entirely plausible on screen.
 */
export const IS_EXPENSE_SQL = `direction = 'debit'
  AND ${OWNED_MONEY_MOVING}
  AND type NOT IN ('card_payment', 'loan_payment')
  AND state <> 'declined'`;

/** Salary and the like. `income_class` distinguishes it further on the row. */
export const IS_EARNED_SQL = `direction = 'credit'
  AND ${OWNED_MONEY_MOVING} AND type = 'income'`;

/**
 * Profit and cashback accrual. §6: "Profit must be counted as income — it's not
 * optional. Exclude it and the master invariant breaks, because net worth rose
 * by money that never appeared in your income figure."
 */
export const IS_PASSIVE_SQL = `direction = 'credit'
  AND ${OWNED_MONEY_MOVING} AND type = 'profit'`;

/** §11.2 — a first-class category. Hiding it makes every other number wrong. */
export const IS_UNCATEGORIZED_SQL = `category_id IS NULL AND ${IS_EXPENSE_SQL}`;
