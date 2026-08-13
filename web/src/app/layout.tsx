import type { Metadata, Viewport } from "next";
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
