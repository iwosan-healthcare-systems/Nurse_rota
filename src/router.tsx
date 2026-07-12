import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Data stays fresh for 5 minutes — re-navigating to a page won't
        // refetch if the cache is still warm. Mutations already call
        // invalidateQueries() for any data that changes, so stale data
        // never surfaces after a write.
        staleTime: 30 * 1000,
        // Keep unused data in memory for 2 minutes.
        gcTime: 2 * 60 * 1000,
        // Don't refetch just because the user switched browser tabs.
        refetchOnWindowFocus: false,
        // One retry is enough — failing fast lets the user see the error
        // sooner rather than waiting through 3 retries.
        retry: 1,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Start fetching when the user hovers a nav link, not after they click.
    defaultPreload: "intent",
    // 30 s: preloaded data is reused when the user actually navigates,
    // so the hover-prefetch isn't wasted by an immediate re-fetch.
    defaultPreloadStaleTime: 30 * 1000,
  });

  return router;
};
