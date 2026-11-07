import type { Project, WorkspaceState } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Repeat } from "lucide-react";

import { useApi } from "@/api/context";

import { RoutinesSection } from "./routines-section";
import { SETTINGS_STACK } from "./settings-group";
import { useWorkspaceChanges } from "./workspace-actions";

/**
 * Settings → Routines: every workspace's routines on one page, each workspace a group of its own
 * with its rows and Add routine, so a schedule is found by name rather than far down a workspace's
 * settings. The same rows and editor as there; a change saves the workspace's charter.
 */
export function RoutinesPage() {
  const api = useApi();
  const { data: workspaces, isPending } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.listWorkspaces(),
  });
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });

  if (isPending) return <p className="text-reading text-muted-foreground">Loading routines…</p>;
  if (workspaces === undefined || workspaces.length === 0) {
    return (
      <div
        data-testid="routines-page-empty"
        className="flex flex-col items-start gap-2 text-reading text-muted-foreground"
      >
        <Repeat aria-hidden className="size-icon-empty" />
        <p>Routines run in a workspace, and there is none yet.</p>
        <Link
          to="/new-workspace"
          className="rounded-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          New workspace…
        </Link>
      </div>
    );
  }
  return (
    <div data-testid="routines-page" className={SETTINGS_STACK}>
      {workspaces.map((state) => (
        <WorkspaceRoutines key={state.workspace.id} state={state} projects={projects} />
      ))}
    </div>
  );
}

/** One workspace's routines under its name, with a way to the rest of its settings. */
function WorkspaceRoutines({
  state,
  projects,
}: {
  state: WorkspaceState;
  projects: readonly Project[];
}) {
  const changes = useWorkspaceChanges(state);
  const count = state.charter.routines?.length ?? 0;
  return (
    <RoutinesSection
      state={state}
      projects={projects}
      changes={changes}
      label={state.workspace.name}
      description={
        <>
          {count === 0 ? "No routines" : count === 1 ? "1 routine" : `${count} routines`}
          {" · "}
          <Link
            to="/settings/workspaces/$workspaceId"
            params={{ workspaceId: state.workspace.id }}
            data-testid="routines-workspace-link"
            className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Workspace settings
          </Link>
        </>
      }
    />
  );
}
