import { createFileRoute } from "@tanstack/react-router";

import { NewTaskDraft } from "@/composer/new-task-draft";

export const Route = createFileRoute("/new-task")({
  validateSearch: (search: Record<string, unknown>): { way?: "direct" } =>
    search["way"] === "direct" ? { way: "direct" } : {},
  component: NewTaskPage,
});

function NewTaskPage() {
  const { way } = Route.useSearch();
  return <NewTaskDraft initialWay={way} />;
}
