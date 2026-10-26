import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/settings` opens the tab open last time. */
export const Route = createFileRoute("/settings/")({
  // Imported here rather than at the top: the route tree is in the first download, and the pages
  // bring every settings section with them.
  beforeLoad: async () => {
    const { lastSettingsPage } = await import("@/settings/pages");
    throw redirect({ to: lastSettingsPage().path, replace: true });
  },
});
