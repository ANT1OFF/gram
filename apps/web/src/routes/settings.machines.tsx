import { createFileRoute } from "@tanstack/react-router";

import { MachinesPage } from "@/settings/machines-page";

/** Settings → Machines: the other machines joined to this Gram, then its pages. */
export const Route = createFileRoute("/settings/machines")({
  component: MachinesPage,
});
