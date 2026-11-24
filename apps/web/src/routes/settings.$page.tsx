import { createFileRoute, redirect } from "@tanstack/react-router";

import { useEmbedShell } from "@/embed/store";

/**
 * An embedding app's own Settings page (`shell.settings.pages`), at `/settings/<id>`. Gram's own
 * pages are routes of their own, which win over this one; an id no page has opens Settings' first.
 */
export const Route = createFileRoute("/settings/$page")({
  beforeLoad: async ({ params }) => {
    const { hostSettingsPage, lastSettingsPage } = await import("@/settings/pages");
    if (hostSettingsPage(params.page) === undefined)
      throw redirect({ to: lastSettingsPage().path, replace: true });
  },
  component: HostSettingsPage,
});

function HostSettingsPage() {
  const { page } = Route.useParams();
  const found = useEmbedShell((s) => s.settings.pages?.find((each) => each.id === page));
  if (found === undefined) return null;
  const Page = found.component;
  return <Page />;
}
