import { PageLoader } from "@/components/ui/loader";

/**
 * Shown while Settings resolves. Every route here is `force-dynamic` and reads
 * Postgres, so without this the tab appears to do nothing until the server
 * answers.
 *
 * The heading renders immediately because it is static — the page announces
 * which tab you landed on straight away, and only the numbers wait.
 */
export default function Loading() {
  return (
    <main>
      <h1 className="text-xl font-semibold">Settings</h1>
      <PageLoader label="Loading settings" />
    </main>
  );
}
