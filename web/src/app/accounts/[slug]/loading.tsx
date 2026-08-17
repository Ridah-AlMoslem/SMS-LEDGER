import { PageLoader } from "@/components/ui/loader";

/**
 * Shown while one account resolves.
 *
 * Every route here is `force-dynamic` and reads Postgres, so without this the
 * tap does nothing visible until the server answers — which is indistinguishable
 * from a dead link. This route needs it more than most: it is reached from
 * Home's net worth strip as well as from the account list, so the wait follows a
 * tap that has just left a screen full of numbers.
 *
 * The heading is deliberately generic. The account's name is in the database,
 * which is the thing being waited on — a static file cannot know it, and
 * guessing it from the slug would render a name that changes when the real one
 * arrives.
 */
export default function Loading() {
  return (
    <main>
      <h1 className="text-xl font-semibold">Account</h1>
      <PageLoader label="Loading this account" />
    </main>
  );
}
