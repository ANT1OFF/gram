import type { Project, RepositoryCandidate } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  FolderGit2,
  FolderOpen,
  Globe,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { CommandText } from "@/launch-checks/command-text";
import { useLaunchChecks } from "@/launch-checks/use-launch-checks";
import { cn } from "@/lib/utils";
import { Expand, Spinner } from "@/motion";
import { AddRepository } from "@/new-thread/add-repository";
import { tildify } from "@/new-thread/path";
import { useHome } from "@/new-thread/use-folder";
import { useWorkspacesQuery } from "@/orchestration/use-orchestration";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useServerSettings } from "@/settings-sync/store";

import { toolRows, type ToolState } from "./tools";

/**
 * Whether this app session shows the first-run screen; decided once, when settings first load, so
 * picking a repository that happens to mark it seen can't close it under the user.
 */
export const useWelcome = create<{ open: boolean | undefined }>()(() => ({ open: undefined }));

/** The most repositories the first run lists before Other folder. */
const RECENT_LIMIT = 6;

/** Whether the first-run screen shows: a first run, while no workspace exists. */
export function useFirstRun(): boolean {
  const settings = useServerSettings((s) => s.settings);
  const open = useWelcome((s) => s.open);
  const { workspaces, settled } = useWorkspacesQuery();
  useEffect(() => {
    if (!settings || useWelcome.getState().open !== undefined) return;
    useWelcome.setState({ open: !settings.onboarding.welcomeSeen });
  }, [settings]);
  return open === true && settled && workspaces.length === 0;
}

/**
 * First run, on one screen: pick a repository, with a read-only tools check beside it. The pick
 * opens the new-workspace sheet on it, which marks the first run done once the workspace is made.
 * Gateways stay in Settings.
 */
export function Welcome() {
  const shown = useFirstRun();
  return shown ? <FirstRun /> : null;
}

function FirstRun() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const save = useSaveSettings();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();

  const record = () =>
    save({ onboarding: { welcomeSeen: true } }).catch((e: unknown) =>
      console.error("welcome: record", e),
    );

  const start = async (project: Project) => {
    await navigate({ to: "/new-workspace", search: { repo: project.id } });
  };

  /** Registers a folder Gram doesn't know yet, then starts on it. */
  const startAt = async (root: string, known?: Project) => {
    if (pending !== undefined) return;
    setPending(root);
    setError(undefined);
    try {
      const project = known ?? (await api.addProject(root));
      if (known === undefined) await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await start(project);
    } catch (e) {
      setError(errorMessage(e) || "Couldn't add that folder.");
    } finally {
      setPending(undefined);
    }
  };

  const chooseFolder = async () => {
    const choose = typeof window === "undefined" ? undefined : window.gram?.chooseFolder;
    if (choose === undefined) return setAdding(true);
    const path = await choose({});
    if (path !== undefined) await startAt(path);
  };

  return (
    <section
      aria-labelledby="welcome-title"
      data-testid="welcome"
      className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-card p-5 text-sm text-card-foreground"
    >
      <h2 id="welcome-title" className="font-heading text-base font-medium">
        Pick a repository to start
      </h2>
      <ToolChips />
      <RecentRepos pending={pending} onPick={(repo, project) => void startAt(repo.root, project)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending !== undefined}
          onClick={() => void chooseFolder()}
        >
          <FolderOpen data-icon="inline-start" />
          Other folder
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={adding}
          disabled={pending !== undefined}
          onClick={() => setAdding((open) => !open)}
        >
          <Globe data-icon="inline-start" />
          Clone from GitHub
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto text-muted-foreground"
          onClick={() => {
            useWelcome.setState({ open: false });
            void record();
          }}
        >
          Skip
        </Button>
      </div>
      <Expand open={adding}>
        {adding && <AddRepository onAdded={(project) => start(project)} />}
      </Expand>
      {error !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

/** The repositories Gram knows or finds in the default and clone folders, a click each. */
function RecentRepos({
  pending,
  onPick,
}: {
  pending: string | undefined;
  onPick: (repo: RepositoryCandidate, project: Project | undefined) => void;
}) {
  const api = useApi();
  const home = useHome();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const { data } = useQuery({
    queryKey: ["projects", "repositories"],
    queryFn: () => api.listRepositories(),
  });
  const repos = (data?.repos ?? []).slice(0, RECENT_LIMIT);
  if (repos.length === 0) return null;
  return (
    <ul aria-label="Repositories" data-testid="welcome-repos" className="flex flex-col gap-0.5">
      {repos.map((repo) => (
        <li key={repo.projectId ?? repo.root}>
          <button
            type="button"
            disabled={pending !== undefined}
            onClick={() =>
              onPick(
                repo,
                projects.find((project) => project.id === repo.projectId),
              )
            }
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
          >
            {pending === repo.root ? (
              <Spinner aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="shrink-0 font-medium whitespace-nowrap">{repo.name}</span>
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {tildify(repo.root, home)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const TOOL_ICON: Record<ToolState, { icon: LucideIcon; label: string; className: string }> = {
  ready: { icon: CheckCircle2, label: "Ready", className: "text-success" },
  attention: { icon: CircleAlert, label: "Needs attention", className: "text-warning" },
  missing: { icon: CircleAlert, label: "Missing", className: "text-destructive" },
  optional: { icon: CircleDashed, label: "Not installed", className: "text-muted-foreground" },
};

/**
 * Claude Code, Codex, git and the GitHub CLI as chips; what to do about one is behind it. Only
 * reads the launch checks; state is never carried by colour alone.
 */
function ToolChips() {
  const { checks, recheck } = useLaunchChecks();
  const [checking, setChecking] = useState(false);
  if (checks === undefined) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner aria-hidden className="size-3.5" />
        Checking tools…
      </p>
    );
  }
  const rows = toolRows(checks);
  const settled = rows.every((row) => row.state === "ready" || row.state === "optional");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ul aria-label="Tools" className="flex flex-wrap gap-1.5">
        {rows.map((row) => {
          const { icon: Icon, label, className } = TOOL_ICON[row.state];
          return (
            <li key={row.tool} data-state={row.state} data-tool={row.tool}>
              <Hint
                label={<CommandText text={row.detail} />}
                render={
                  <span
                    // Focusable, so the remedy behind it reaches the keyboard too.
                    tabIndex={0}
                    className={cn(
                      "flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      row.state === "optional" && "text-muted-foreground",
                    )}
                  />
                }
              >
                <Icon aria-label={label} className={cn("size-3", className)} />
                {row.name}
                <span className="sr-only">: {row.detail.replaceAll("`", "")}</span>
              </Hint>
            </li>
          );
        })}
      </ul>
      {!settled && (
        <Button
          size="xs"
          variant="ghost"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            recheck()
              .catch((error: unknown) => console.error("welcome: re-check tools", error))
              .finally(() => setChecking(false));
          }}
        >
          {checking ? "Checking…" : "Check again"}
        </Button>
      )}
    </div>
  );
}
