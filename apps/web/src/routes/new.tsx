import { createFileRoute } from "@tanstack/react-router";

import { NewThreadDraft } from "@/composer/new-thread-draft";

export const Route = createFileRoute("/new")({
  component: NewThreadDraft,
});
