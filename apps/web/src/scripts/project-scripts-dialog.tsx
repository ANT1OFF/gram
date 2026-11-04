import type { ProjectId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogShell } from "@/thread/dialog-shell";

import { ProjectScriptsEditor } from "./project-scripts-editor";

/** The project's scripts to edit, from the Run script menu or the palette. */
export function ProjectScriptsDialog({
  projectId,
  onClose,
}: {
  projectId: ProjectId;
  onClose: () => void;
}) {
  const api = useApi();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const name = projects.find((project) => project.id === projectId)?.name;
  return (
    <DialogShell
      testId="project-scripts-dialog"
      title={name === undefined ? "Project scripts" : `Project scripts · ${name}`}
      description="Commands you run often, one click or key away. Each runs in the thread's folder, in a terminal tab named after it."
      onClose={onClose}
      className="w-[min(40rem,92vw)]"
    >
      <ProjectScriptsEditor projectId={projectId} />
      <div className="flex justify-end">
        <Dialog.Close render={<Button type="button" size="sm" variant="outline" />}>
          Done
        </Dialog.Close>
      </div>
    </DialogShell>
  );
}
