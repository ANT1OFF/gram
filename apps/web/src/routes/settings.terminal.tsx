import { createFileRoute, redirect } from "@tanstack/react-router";

import { TerminalSection } from "@/settings/terminal-section";

/** Off Windows the Terminal tab has no setting and isn't listed, so a link to it opens General. */
export const Route = createFileRoute("/settings/terminal")({
  // The pages bring every settings section with them, so they aren't imported with the route tree.
  beforeLoad: async () => {
    const { SETTINGS_PAGES } = await import("@/settings/pages");
    if (!SETTINGS_PAGES.some((page) => page.id === "terminal")) {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: TerminalSection,
});
