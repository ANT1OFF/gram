import type { Project } from "@gram/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

/** Removes a project from the `/new` recents; the server refuses while threads belong to it. */
export function ForgetProjectButton({ project }: { project: Project }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.forgetProject(project.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
    onError: (error) =>
      useThreadDialogs
        .getState()
        .fail(`Couldn't remove ${project.name} from recents: ${errorMessage(error)}`),
  });

  return (
    <button
      type="button"
      aria-label={`Remove ${project.name} from recents`}
      title="Remove from recents"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      className="shrink-0 rounded-sm p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <X aria-hidden className="size-3.5" />
    </button>
  );
}
