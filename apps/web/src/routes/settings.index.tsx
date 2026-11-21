import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/settings` opens the tab open last time. */
export const Route = createFileRoute("/settings/")({
  beforeLoad: async () => {
    const { lastSettingsPage } = await import("@/settings/pages");
    throw redirect({ to: lastSettingsPage().path, replace: true });
  },
});
