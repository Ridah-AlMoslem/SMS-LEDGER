"use client";

/**
 * "Always categorize <merchant> as <category>", and the dry run that has to
 * come before it touches anything (SPEC §11.1, §9.5).
 *
 * §11.1 asks for "apply to N matching historical transactions", and the order
 * matters more than the wording: the rule is written first and applies to
 * everything that arrives from now on, then the preview asks the separate and
 * much larger question of what to do with the history that already exists.
 * Applying is its own confirm, with the count and the list in front of it.
 *
 * The list is not decoration. The risk of a rule keyed on a merchant string is
 * that the string is more general than you thought — "JARIR" catches the
 * bookshop and the print shop — and the only way to see that is to read the
 * transactions it caught before agreeing to re-categorize four years of them.
 *
 * Managing and reordering rules is Settings' job (§11.1). This is only the
 * place they get created, next to the transaction that prompted one.
 */

import { Loader } from "@/components/ui/loader";
import { Money } from "@/components/ui/money";
import type { RulePreview } from "@/db/rules";
import { type RuleDraft, describeMatch } from "@/lib/rules";
import { civilShort } from "@/lib/periods";

export function RuleOffer({
  draft,
  saved,
  saving,
  applying,
  applied,
  onCreate,
  onApply,
  onDismiss,
}: {
  draft: RuleDraft;
  saved: { ruleId: string; preview: RulePreview } | null;
  saving: boolean;
  applying: boolean;
  applied: number | null;
  onCreate: () => void;
  onApply: (ruleId: string) => void;
  onDismiss: () => void;
}) {
  if (applied !== null) {
    return (
      <div className="mt-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
        <p>
          Applied to <span className="tabular font-medium">{applied}</span>{" "}
          {applied === 1 ? "transaction" : "transactions"}. The rule stays on for everything that
          arrives from now on — Settings is where it can be edited or turned off.
        </p>
        <button type="button" onClick={onDismiss} className="mt-1.5 underline underline-offset-2">
          Done
        </button>
      </div>
    );
  }

  if (!saved) {
    return (
      <button
        type="button"
        onClick={onCreate}
        disabled={saving}
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-black/15 px-2.5 py-1.5 text-xs hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
      >
        {saving && <Loader size={14} variant="arrows" label="Checking the rule" />}
        {saving ? "Checking history…" : `Always categorize ${draft.name.split(" → ")[0]} this way`}
      </button>
    );
  }

  const { preview } = saved;

  return (
    <div className="mt-2 rounded-lg border border-black/12 p-3 dark:border-white/18">
      <p className="text-xs font-medium">
        Rule saved: <span className="sms-body">{describeMatch(draft.match)}</span>
      </p>
      <p className="mt-1 text-[11px] opacity-60">
        It applies to everything that arrives from now on. Nothing in your history has changed
        yet.
      </p>

      <p className="mt-2.5 text-xs">
        {preview.matched === 0 ? (
          <>No historical transaction matches it.</>
        ) : (
          <>
            Matches <span className="tabular font-medium">{preview.matched}</span> historical{" "}
            {preview.matched === 1 ? "transaction" : "transactions"};{" "}
            <span className="tabular font-medium">{preview.wouldChange}</span> would change.
          </>
        )}
      </p>

      {(preview.locked > 0 || preview.unchanged > 0) && (
        <p className="mt-1 text-[11px] opacity-60">
          {preview.unchanged > 0 && (
            <>
              <span className="tabular">{preview.unchanged}</span> already in that category.
            </>
          )}{" "}
          {preview.locked > 0 && (
            <>
              <span className="tabular">{preview.locked}</span> categorized by hand and left alone
              — a manual edit always beats a rule.
            </>
          )}
        </p>
      )}

      {preview.rows.length > 0 && (
        <ul className="mt-2 max-h-52 divide-y divide-black/8 overflow-y-auto dark:divide-white/10">
          {preview.rows.map((row) => (
            <li key={row.id} className="flex items-center gap-2 py-1.5 text-[11px]">
              <span className="min-w-0 flex-1">
                <span className="sms-body block truncate">{row.label}</span>
                <span className="block truncate opacity-55">
                  {civilShort(row.postedAt.slice(0, 10))} · {row.accountName}
                  {row.categoryName ? ` · ${row.categoryName}` : ""}
                  {row.locked ? " · locked" : row.wouldChange ? "" : " · already set"}
                </span>
              </span>
              <Money
                value={row.direction === "credit" ? Number(row.amount) : -Number(row.amount)}
                className="shrink-0 text-[11px]"
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={applying || preview.wouldChange === 0}
          onClick={() => onApply(saved.ruleId)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-40 dark:border-white/20 dark:hover:bg-white/10"
        >
          {applying && <Loader size={16} variant="arrows" label="Applying the rule" />}
          {applying
            ? "Applying…"
            : preview.wouldChange === 0
              ? "Nothing to apply"
              : `Apply to ${preview.wouldChange}`}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="px-2 py-1.5 text-sm opacity-60 hover:opacity-100"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
