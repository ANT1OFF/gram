import { createFileRoute } from "@tanstack/react-router";

import { StoragePage } from "@/settings/storage-page";

export const Route = createFileRoute("/settings/storage")({
  component: StoragePage,
});
