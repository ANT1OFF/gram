import { createFileRoute, redirect } from "@tanstack/react-router";

import { TerminalSection } from "@/settings/terminal-section";

/** Off Windows the Terminal tab has no setting and isn't listed, so a link to it opens General. */
export const Route = createFileRoute("/settings/terminal")({
  beforeLoad: async () => {
    const { shownSettingsPages } = await import("@/settings/pages");
    if (!shownSettingsPages().some((page) => page.id === "terminal")) {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: TerminalSection,
});
