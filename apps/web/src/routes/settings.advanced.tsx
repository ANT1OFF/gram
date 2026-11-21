import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Settings had an Advanced page until its pages moved into the groups they belong to. An old link
 * to it opens General, and one to a page under it, such as `/settings/advanced/gateways`, that page.
 */
export const Route = createFileRoute("/settings/advanced")({
  beforeLoad: async ({ location }) => {
    const { advancedRedirect } = await import("@/settings/pages");
    throw redirect({ to: advancedRedirect(location.pathname), replace: true });
  },
});
