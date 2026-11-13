import { createFileRoute } from "@tanstack/react-router";

import { GeneralPage } from "@/settings/general-page";

export const Route = createFileRoute("/settings/general")({
  component: GeneralPage,
});
