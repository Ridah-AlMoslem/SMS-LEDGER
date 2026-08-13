import { inArray, sql } from "drizzle-orm";
import { Suspense } from "react";
import type { Metadata, Viewport } from "next";

import { PeriodHeader } from "@/components/period-header";
import { TabBar } from "@/components/tab-bar";
import { getDb, schema } from "@/db";

import "./globals.css";

/**
 * No next/font/google here, deliberately.
 *
 * Geist has no Arabic coverage, and this dashboard renders Arabic merchant
 * names and message bodies alongside English ones. The system stack in
 * globals.css picks up the platform's Arabic face (Geeza Pro / Segoe UI
 * Arabic / Noto Sans Arabic) automatically, matches the numerals to the
 * surrounding text, and removes a build-time network fetch.
 */

export const metadata: Metadata = {
  title: "Ledger",
  description: "Personal financial ledger built from bank SMS",
  applicationName: "Ledger",
};

/**
 * Both theme colors are the same near-black. The tab strip and the iOS status
 * bar should match the dark surface the icon tile sits on, and the app's light
 * mode is a plain white page that browsers already handle correctly.
 */
export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

// The parked count is read on every navigation, so there is nothing here to
// prerender. The pages below say the same thing for their own data.
export const dynamic = "force-dynamic";

/**
 * The review queue depth, counted once for the whole app.
 *
 * In the layout rather than per page so the badge does not appear, vanish and
 * reappear as you move between tabs — a count that flickers reads as an alert
 * firing, which is precisely the wrong signal for a number that is usually
 * zero and boring.
 *
 * Returns 0 when the database is unreachable. A nav bar that takes the whole
 * app down because it could not count something is a worse failure than a
 * missing badge, and every page renders its own connection error already.
 */
async function parkedCount(): Promise<number> {
  try {
    const [row] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.rawMessages)
      .where(inArray(schema.rawMessages.status, ["needs_review", "failed"]));

    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const parked = await parkedCount();

  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        {/* Both read the URL, which is a request-time value; the Suspense
            boundary keeps that from pulling the whole tree client-side. */}
        <div className="mx-auto w-full max-w-2xl flex-1 px-6 pt-2 pb-6">
          <Suspense fallback={<div className="mb-5 h-[52px]" />}>
            <PeriodHeader />
          </Suspense>
          {children}
        </div>

        <Suspense fallback={<div className="h-[57px]" />}>
          <TabBar parked={parked} />
        </Suspense>
      </body>
    </html>
  );
}
