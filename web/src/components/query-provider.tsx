"use client";

/**
 * The TanStack Query client, mounted only where it is needed.
 *
 * Not in the root layout: Ledger is the one screen with a client-side cache,
 * because it is the one screen that edits. Every other page is a server
 * component reading Postgres directly, and hoisting a provider into the layout
 * would ship this to all of them for nothing.
 *
 * `staleTime` is deliberately non-zero. The list is re-fetched after every
 * mutation anyway, and a zero stale time makes React Query re-request the page
 * on every remount — which on a phone means every time the detail sheet closes.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            // The pull-to-refresh gesture and the mutations own refetching.
            // A focus refetch on top of those makes the list jump when you come
            // back from the banking app, which is precisely when you are
            // comparing two figures side by side.
            refetchOnWindowFocus: false,
            retry: 1,
          },
          mutations: { retry: 0 },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
