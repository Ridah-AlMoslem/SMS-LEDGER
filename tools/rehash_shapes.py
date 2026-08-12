"""Recompute every stored shape_hash after a change to the hashing rules.

Run once after any edit to `shape_hash`:

    python3 tools/rehash_shapes.py            # show what would change
    python3 tools/rehash_shapes.py --apply    # write it

Why this is needed: `raw_messages.shape_hash` is a cached derivation, and the
review queue groups by it. Leave it stale and the queue groups messages by the
OLD rules — which, in the case that prompted this, means not grouping them at
all.

`sms_templates.shape_hash` is deliberately NOT recomputed: the source message a
template was derived from is not recorded, so there is nothing to rehash from.
That only affects which messages `requeue_shape` targets, never whether a
template matches — matching is by sender and regex. Any template whose shape
key is stale is reported so it can be re-derived from the review screen.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "api"))

import db as store  # noqa: E402
from ledger.normalize import shape_hash  # noqa: E402


def main(apply: bool) -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        # Fall back to the parser service's env file so this is runnable
        # without exporting anything.
        env = os.path.join(HERE, "..", "api", ".env")
        if os.path.exists(env):
            for line in open(env, encoding="utf-8"):
                line = line.strip()
                if line.startswith("DATABASE_URL=") and len(line) > 13:
                    url = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    if not url:
        print("DATABASE_URL is not set, and api/.env has no value for it.")
        return 1

    changed = unchanged = 0
    with store.connect(url) as conn:
        rows = conn.execute(
            "SELECT id, body, shape_hash FROM raw_messages ORDER BY received_at"
        ).fetchall()

        # Measured before any UPDATE, or the count reflects the new rules and
        # the comparison becomes meaningless.
        before = conn.execute(
            "SELECT count(DISTINCT shape_hash)::int n FROM raw_messages"
        ).fetchone()["n"]
        after = len({shape_hash(r["body"]) for r in rows})

        for row in rows:
            fresh = shape_hash(row["body"])
            if fresh == row["shape_hash"]:
                unchanged += 1
                continue
            changed += 1
            if apply:
                conn.execute(
                    "UPDATE raw_messages SET shape_hash = %s WHERE id = %s",
                    (fresh, row["id"]),
                )

        if apply:
            conn.commit()
        else:
            conn.rollback()

        stale = conn.execute(
            """
            SELECT t.id, t.sender, t.kind
            FROM sms_templates t
            WHERE NOT EXISTS (
                SELECT 1 FROM raw_messages r WHERE r.shape_hash = t.shape_hash
            )
            """
        ).fetchall()

    print(f"messages          : {len(rows)}")
    print(f"  rehashed        : {changed}")
    print(f"  already current : {unchanged}")
    print(f"distinct shapes   : {before} → {after}")

    if stale:
        print(f"\n{len(stale)} derived template(s) no longer match any message's shape.")
        print("Re-derive them from /review; matching still works, but 'retry all'")
        print("will not find their messages:")
        for t in stale:
            print(f"  {t['sender']:<14} {t['kind']}")

    if not apply:
        print("\nDry run. Re-run with --apply to write.")
    return 0


if __name__ == "__main__":
    sys.exit(main("--apply" in sys.argv))
