import { createFileRoute } from "@tanstack/react-router";

import { DiagnosticsSection } from "@/settings/diagnostics-section";

export const Route = createFileRoute("/settings/diagnostics")({
  component: DiagnosticsSection,
});
