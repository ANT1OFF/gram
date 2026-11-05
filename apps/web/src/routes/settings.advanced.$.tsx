import { createFileRoute } from "@tanstack/react-router";

/** `/settings/advanced/<page>`: `settings.advanced.tsx` sends it to the page's own route. */
export const Route = createFileRoute("/settings/advanced/$")({});
