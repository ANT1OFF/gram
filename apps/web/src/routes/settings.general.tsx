import { createFileRoute } from "@tanstack/react-router";

import { GeneralPage } from "@/settings/pages";

export const Route = createFileRoute("/settings/general")({
  component: GeneralPage,
});
