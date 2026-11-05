import { createFileRoute, redirect } from "@tanstack/react-router";

/** Updates is part of About now; an old link to it lands there. */
export const Route = createFileRoute("/settings/updates")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/about", search, replace: true });
  },
});
