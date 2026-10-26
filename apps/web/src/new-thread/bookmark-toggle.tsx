import type { Project } from "@gram/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bookmark } from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { cn } from "@/lib/utils";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

/** Bookmarks a project for the `/new` Bookmarks section, or removes the bookmark. */
export function BookmarkToggle({ project, className }: { project: Project; className?: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (bookmarked: boolean) => api.setProjectBookmarked(project.id, bookmarked),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
    onError: (error) =>
      useThreadDialogs.getState().fail(`Couldn't update the bookmark: ${errorMessage(error)}`),
  });
  const on = project.bookmarked;

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Remove bookmark from ${project.name}` : `Bookmark ${project.name}`}
      title={on ? "Remove bookmark" : "Bookmark this project"}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(!on)}
      className={cn(
        "shrink-0 rounded-sm p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:text-foreground",
        className,
      )}
    >
      <Bookmark aria-hidden className={cn("size-3.5", on && "fill-current")} />
    </button>
  );
}
