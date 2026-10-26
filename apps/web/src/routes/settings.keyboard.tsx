import { createFileRoute } from "@tanstack/react-router";

import { KeyboardSection } from "@/settings/keyboard-section";

export const Route = createFileRoute("/settings/keyboard")({
  component: KeyboardSection,
});
