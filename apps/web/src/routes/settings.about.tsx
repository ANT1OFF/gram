import { createFileRoute } from "@tanstack/react-router";

import { AboutPage } from "@/settings/pages";

export const Route = createFileRoute("/settings/about")({
  component: AboutPage,
});
