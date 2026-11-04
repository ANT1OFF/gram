import type { Project, RepositoryCandidate } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  FolderGit2,
  FolderOpen,
  GitPullRequest,
  Globe,
  History,
  MessageSquare,
  Network,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";

import { AgentIcon } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { ShortcutKbd } from "@/keyboard/use-shortcut-hint";
import { CommandText } from "@/launch-checks/command-text";
import { useLaunchChecks } from "@/launch-checks/use-launch-checks";
import { cn } from "@/lib/utils";
import { Expand, Spinner } from "@/motion";
import { AddRepository } from "@/new-thread/add-repository";
import { tildify } from "@/new-thread/path";
import { useHome } from "@/new-thread/use-folder";
import { useWorkspacesQuery } from "@/orchestration/use-orchestration";
import { ResumeSessions } from "@/resume/resume-sessions";
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
 * First run, on one screen: what Gram does in three rows, whether Claude Code and Codex are
 * installed and signed in, and a repository to start on. The pick opens the new-workspace sheet on
 * it, which marks the first run done once the workspace is made. Past CLI sessions can be picked up
 * from here too. Gateways stay in Settings.
 */
export function Welcome() {
  const shown = useFirstRun();
  return shown ? <FirstRun /> : null;
}

/** What Gram does, in the order it happens. */
const STEPS: readonly { icon: LucideIcon; title: string; line: ReactNode }[] = [
  {
    icon: MessageSquare,
    title: "You give tasks",
    line: (
      <>
        In plain words, from New <ShortcutKbd id="thread.new" /> or an orchestrator's chat.
      </>
    ),
  },
  {
    icon: Network,
    title: "An orchestrator plans them and briefs workers",
    line: "One per workspace. It splits a task into pieces and follows each one through.",
  },
  {
    icon: GitPullRequest,
    title: "Workers run Claude Code or Codex",
    line: "Each in its own worktree, on your own subscription, and each opens a pull request.",
  },
];

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
      className="flex w-full max-w-xl flex-col gap-5 rounded-lg border border-border bg-card p-5 text-sm text-card-foreground"
    >
      <div className="flex flex-col gap-3">
        <h2 id="welcome-title" className="font-heading text-base font-medium">
          How Gram works
        </h2>
        <ol aria-label="How Gram works" data-testid="welcome-steps" className="flex flex-col gap-3">
          {STEPS.map(({ icon: Icon, title, line }) => (
            <li key={title} className="flex items-start gap-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-muted-foreground">
                <Icon aria-hidden className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{title}</span>
                <span className="text-xs text-muted-foreground">{line}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <AgentStrip />
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="font-heading text-sm font-medium">Pick a repository to start</h3>
          <p className="text-xs text-muted-foreground">
            It becomes a workspace with its own orchestrator. You can add more repositories later.
          </p>
        </div>
        <RecentRepos
          pending={pending}
          onPick={(repo, project) => void startAt(repo.root, project)}
        />
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
      </div>
      <ImportSessions />
    </section>
  );
}

/** The repositories the first run offers, shared by the picker and the session import. */
function useFirstRunRepos() {
  const api = useApi();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const { data } = useQuery({
    queryKey: ["projects", "repositories"],
    queryFn: () => api.listRepositories(),
  });
  return { projects, repos: (data?.repos ?? []).slice(0, RECENT_LIMIT) };
}

/**
 * Sessions started in a terminal with Claude Code or Codex, picked up as threads: a repository
 * first, then its past sessions, as ⌘K's Resume past session lists them.
 */
function ImportSessions() {
  const { repos } = useFirstRunRepos();
  const [open, setOpen] = useState(false);
  const [root, setRoot] = useState<string>();
  const folder = root ?? repos[0]?.root;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          data-testid="welcome-import"
          className="-ml-2.5"
          onClick={() => setOpen((was) => !was)}
        >
          <History data-icon="inline-start" />
          Import past CLI sessions
        </Button>
        <span className="text-xs text-muted-foreground">
          Pick up a Claude Code or Codex session you started in a terminal.
        </span>
      </div>
      <Expand open={open}>
        {open && (
          <div className="flex flex-col gap-2">
            {repos.length > 1 && (
              <div
                role="radiogroup"
                aria-label="Sessions from"
                className="flex flex-wrap items-center gap-1"
              >
                {repos.map((repo) => (
                  <button
                    key={repo.root}
                    type="button"
                    role="radio"
                    aria-checked={repo.root === folder}
                    onClick={() => setRoot(repo.root)}
                    className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-checked:border-ring aria-checked:bg-accent aria-checked:text-foreground"
                  >
                    {repo.name}
                  </button>
                ))}
              </div>
            )}
            {folder === undefined ? (
              <p className="text-xs text-muted-foreground">
                Pick a repository above first; sessions are listed by the folder they ran in.
              </p>
            ) : (
              <ResumeSessions key={folder} projectRoot={folder} />
            )}
          </div>
        )}
      </Expand>
    </div>
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
  const home = useHome();
  const { projects, repos } = useFirstRunRepos();
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

/** How each state reads beside its icon: never by colour alone. */
const STATE: Readonly<Record<ToolState, { icon: LucideIcon; words: string; className: string }>> = {
  ready: { icon: CircleCheck, words: "Signed in", className: "text-success" },
  attention: { icon: CircleAlert, words: "Needs sign-in", className: "text-warning" },
  missing: { icon: CircleX, words: "Not installed", className: "text-destructive" },
  optional: { icon: Circle, words: "Not installed", className: "text-muted-foreground" },
};

/**
 * Claude Code and Codex, each installed and signed in or not, from the launch checks Settings →
 * Agents reads; git only when it is missing. What to do about one is on its hover and focus. Only
 * reads the checks, and Check again runs them once more.
 */
function AgentStrip() {
  const { checks, recheck } = useLaunchChecks();
  const [checking, setChecking] = useState(false);
  const rows =
    checks === undefined
      ? []
      : toolRows(checks).filter(
          (row) =>
            row.tool === "claude" ||
            row.tool === "codex" ||
            (row.tool === "git" && row.state !== "ready"),
        );
  const trouble = rows.some((row) => row.state === "attention" || row.state === "missing");
  return (
    <div
      data-testid="welcome-agents"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md bg-accent/60 px-3 py-2 text-xs"
    >
      {checks === undefined ? (
        <span role="status" className="text-muted-foreground">
          Checking your agents…
        </span>
      ) : (
        <ul aria-label="Agents" className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {rows.map((row) => {
            const state = STATE[row.state];
            const Icon = state.icon;
            const words = row.tool === "git" ? "Not installed" : state.words;
            return (
              <li key={row.tool} data-state={row.state} data-tool={row.tool}>
                <Hint
                  label={<CommandText text={row.detail} />}
                  render={
                    <span
                      // Focusable, so the version or the remedy behind it reaches the keyboard too.
                      tabIndex={0}
                      className="flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                  }
                >
                  {row.tool === "git" ? (
                    <FolderGit2 aria-hidden className="size-3.5 text-muted-foreground" />
                  ) : (
                    <AgentIcon agent={row.tool} className="size-3.5" />
                  )}
                  <span className="font-medium">{row.name}</span>
                  <Icon aria-hidden className={cn("size-3.5", state.className)} />
                  <span className="text-muted-foreground">{words}</span>
                  <span className="sr-only">: {row.detail.replaceAll("`", "")}</span>
                </Hint>
              </li>
            );
          })}
        </ul>
      )}
      {trouble && (
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
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
