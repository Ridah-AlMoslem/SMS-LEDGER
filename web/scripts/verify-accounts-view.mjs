/**
 * Checks the account presentation rules (SPEC §3.3).
 *
 * The credit-card rule is the easiest thing in this system to invert, and
 * inverting it moves net worth by roughly the full credit limit while looking
 * completely plausible on screen. That deserves an assertion, not a glance.
 *
 * Run: npm run test:accounts
 *   (node --experimental-strip-types; Node 22.6+)
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src", "lib", "accounts.ts");

// Imports the real TypeScript module directly, using Node's built-in type
// stripping — no esbuild, no bundler, no parallel JavaScript copy that would
// drift from the source it claims to test.
//
// Node's native stripping also means this runs on any platform. esbuild ships
// a per-platform native binary, and node_modules installed on one OS cannot be
// used from another; a test that can only run on the machine that last ran
// npm install is not much of a test.
const { toView, groupByInstitution, totals } = await import(pathToFileURL(SRC).href);

const account = (over) => ({
  id: over.slug,
  slug: over.slug,
  name: over.slug,
  institution: over.institution ?? "X",
  type: "checking",
  isLiability: false,
  balanceSemantics: "balance",
  reconcilable: true,
  currentBalance: "0",
  creditLimit: null,
  isProfitBearing: false,
  balanceAsOf: null,
  sortOrder: 0,
  ...over,
});

let n = 0;
const check = (name, fn) => {
  fn();
  n++;
  console.log(`  PASS  ${name}`);
};

console.log("\n[1] CREDIT CARD — available credit is not debt");
{
  const card = toView(
    account({
      slug: "card",
      type: "credit_card",
      isLiability: true,
      balanceSemantics: "available_credit",
      currentBalance: "9610.09",
      creditLimit: "14000.00",
    }),
  );

  check("debt is limit − reported balance", () => assert.equal(card.debt, 4389.91));
  check("net worth contribution is negative", () => assert.equal(card.net, -4389.91));
  check("available credit is the reported figure", () => assert.equal(card.available, 9610.09));
  check("utilisation is debt over limit", () =>
    assert.equal(Math.round(card.utilisation * 100), 31));
  check("net is NOT the reported balance", () => assert.notEqual(card.net, 9610.09));
}

console.log("\n[2] PLAIN LIABILITY — balance IS the debt");
{
  const loan = toView(
    account({ slug: "loan", type: "loan", isLiability: true, currentBalance: "5000.00" }),
  );
  check("owes the stated balance", () => assert.equal(loan.debt, 5000));
  check("lowers net worth", () => assert.equal(loan.net, -5000));
}

console.log("\n[3] ASSETS");
{
  const savings = toView(account({ slug: "savings", currentBalance: "71902.86" }));
  check("raises net worth", () => assert.equal(savings.net, 71902.86));
  check("carries no debt", () => assert.equal(savings.debt, null));
}

console.log("\n[4] GROUPING AND TOTALS");
{
  const groups = groupByInstitution([
    account({ slug: "saib_current", institution: "SAIB", currentBalance: "0" }),
    account({ slug: "saib_savings", institution: "SAIB", currentBalance: "71902.86" }),
    account({ slug: "ar_current", institution: "AlRajhiBank", currentBalance: "0" }),
    account({
      slug: "ar_card",
      institution: "AlRajhiBank",
      type: "credit_card",
      isLiability: true,
      balanceSemantics: "available_credit",
      currentBalance: "9610.09",
      creditLimit: "14000.00",
    }),
    account({ slug: "ar_cashback", institution: "AlRajhiBank", currentBalance: "52.92" }),
    account({ slug: "barq", institution: "barq app", currentBalance: "0" }),
    account({ slug: "stc", institution: "STC Bank", currentBalance: "13.15" }),
  ]);

  check("one group per institution", () => assert.equal(groups.length, 4));
  check("AlRajhi accounts grouped together", () =>
    assert.equal(groups.find((g) => g.institution === "AlRajhiBank").accounts.length, 3));
  check("AlRajhi subtotal is net of card debt", () =>
    assert.equal(
      Math.round(groups.find((g) => g.institution === "AlRajhiBank").net * 100) / 100,
      -4336.99,
    ));
  check("institution label is humanised", () =>
    assert.equal(groups.find((g) => g.institution === "barq app").label, "Barq"));

  const t = totals(groups);
  check("assets exclude the card", () =>
    assert.equal(Math.round(t.assets * 100) / 100, 71968.93));
  check("debt is the derived card debt", () =>
    assert.equal(Math.round(t.debt * 100) / 100, 4389.91));
  check("net worth matches the seeded figure", () =>
    assert.equal(Math.round(t.netWorth * 100) / 100, 67579.02));
}

console.log(`\n${"=".repeat(60)}\nALL ${n} ACCOUNT-VIEW CHECKS PASS\n${"=".repeat(60)}`);
