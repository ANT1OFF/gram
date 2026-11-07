import { createFileRoute } from "@tanstack/react-router";

import { RoutinesPage } from "@/settings/routines-page";

export const Route = createFileRoute("/settings/routines")({
  component: RoutinesPage,
});
