import { Popover } from "@base-ui/react/popover";
import type { Project } from "@gram/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { projectScriptsKey } from "@/scripts/use-project-scripts";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { FolderTrustQuestion } from "./folder-trust-question";

/**
 * A project whose folder isn't trusted says so on its row, and asks there: its own agent settings
 * and scripts stay off until the user trusts it. Nothing shows for a trusted folder, or for one
 * never asked about that brings nothing.
 */
export function TrustFolderButton({ project }: { project: Project }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const settings = useQuery({
    queryKey: ["folderSettings", project.root],
    queryFn: () => api.folderSettings(project.root),
    enabled: project.folderTrust !== "trusted",
    staleTime: 30_000,
  });
  const trust = useMutation({
    mutationFn: () => api.setFolderTrust(project.id, true),
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: projectScriptsKey(project.id) });
    },
    onError: (error) =>
      useThreadDialogs.getState().fail(`Couldn't trust ${project.name}: ${errorMessage(error)}`),
  });
  if (project.folderTrust === "trusted" || settings.data === undefined) return null;
  if (project.folderTrust === undefined && settings.data.none) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={`${project.name} isn't trusted`}
        title="Not trusted: its own agent settings and scripts are off"
        className="flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 text-meta text-warning-text outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ShieldAlert aria-hidden className="size-icon-row" />
        Not trusted
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} className="isolate z-50">
          <Popover.Popup className="w-80 max-w-(--available-width) rounded-lg bg-popover text-popover-foreground shadow-overlay outline-none">
            <FolderTrustQuestion
              settings={settings.data}
              actions={
                <>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
                    Not now
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={trust.isPending}
                    onClick={() => trust.mutate()}
                  >
                    Trust {project.name}
                  </Button>
                </>
              }
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
