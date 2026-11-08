import { createFileRoute } from "@tanstack/react-router";

/** Settings → Machines: for now only its pages, listed under it by the layout. */
export const Route = createFileRoute("/settings/machines")({
  component: () => null,
});
