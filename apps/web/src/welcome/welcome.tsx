import type { Project, RepositoryCandidate } from "@gram/contracts";
import { Menu } from "@base-ui/react/menu";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  GitPullRequest,
  Globe,
  History,
  MessageSquare,
  Network,
  Plus,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { create } from "zustand";

import { AgentIcon } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { ChoiceCheck } from "@/components/choice-check";
import { Hint } from "@/components/hint";
import { Button, buttonVariants } from "@/components/ui/button";
import { ShortcutKbd } from "@/keyboard/use-shortcut-hint";
import { CommandText } from "@/launch-checks/command-text";
import { useLaunchChecks } from "@/launch-checks/use-launch-checks";
import { MENU_ITEM, MENU_POPUP } from "@/lib/selection";
import { focusLost } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { Expand, Spinner } from "@/motion";
import { OutboundLink } from "@/panels/outbound-link";
import { AddRepository } from "@/new-thread/add-repository";
import { tildify } from "@/new-thread/path";
import { useHome } from "@/new-thread/use-folder";
import { useWorkspacesQuery } from "@/orchestration/use-orchestration";
import { ResumeSessions } from "@/resume/resume-sessions";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";

import { matchRepos, RECENT_LIMIT } from "./repo-search";
import { runsWith, toolRows, type ToolState } from "./tools";

/**
 * Whether this app session shows the first-run screen; decided once, when settings first load, so
 * picking a repository that happens to mark it seen can't close it under the user.
 */
export const useWelcome = create<{ open: boolean | undefined }>()(() => ({ open: undefined }));

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
 * Before any setup: the first run, with no thread yet. What only means something once there is
 * work (pull requests, usage, what needs you) stays away, so the welcome is the one thing to look
 * at.
 */
export function useBeforeSetup(): boolean {
  const firstRun = useFirstRun();
  const empty = useThreadsStore((s) => Object.keys(s.byId).length === 0);
  return firstRun && empty;
}

/**
 * First run, on one screen: a repository to start on, whether Claude Code and Codex are installed
 * and signed in beside the action that opens it, and what Gram does in three rows under How it
 * works, folded until asked for. The pick opens the new-workspace sheet on
 * it, which marks the first run done once the workspace is made. Past CLI sessions can be picked up
 * from here too. Gateways stay in Settings.
 */
export function Welcome() {
  const shown = useFirstRun();
  return shown ? <FirstRun /> : null;
}

/** What Gram does, in the order it happens. */
const STEPS: readonly { icon: LucideIcon; short: string; line: ReactNode }[] = [
  {
    icon: MessageSquare,
    short: "You give tasks",
    line: (
      <>
        In plain words, from New <ShortcutKbd id="thread.new" /> or an orchestrator's chat.
      </>
    ),
  },
  {
    icon: Network,
    short: "An orchestrator briefs workers",
    line: "One per workspace. It splits a task into pieces and follows each one through.",
  },
  {
    icon: GitPullRequest,
    short: "Each worker opens a PR",
    line: "Workers run Claude Code or Codex, each in its own worktree, on your own subscription.",
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

  const { projects, all } = useFirstRunRepos();
  const home = useHome();
  // Past a screenful of repositories, a search finds one; it has the focus, so typing starts it.
  const [query, setQuery] = useState("");
  const searchable = all.length > RECENT_LIMIT;
  const matches = matchRepos(all, query);
  const repos = matches.slice(0, RECENT_LIMIT);
  // The most recent repository is picked to start with, so Open is the obvious first click; a
  // search picks its best match unless the pick is still among them.
  const [pickedRoot, setPickedRoot] = useState<string>();
  const picked = repos.find((repo) => repo.root === pickedRoot) ?? repos[0];
  const openRepo = (repo: RepositoryCandidate) =>
    void startAt(
      repo.root,
      projects.find((project) => project.id === repo.projectId),
    );

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
      className="flex w-full max-w-xl flex-col gap-5 rounded-lg border border-edge bg-card p-5 text-reading text-card-foreground"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="welcome-title" className="font-heading text-title">
            Pick a repository to start
          </h2>
          <p data-testid="welcome-line" className="text-meta text-muted-foreground">
            A workspace groups your repositories, and its orchestrator coordinates the agents that
            work in them.
          </p>
        </div>
        {searchable && (
          <RepoSearch
            query={query}
            total={all.length}
            listed={repos.length > 0}
            onQuery={setQuery}
            onOpen={() => {
              if (picked !== undefined) openRepo(picked);
            }}
          />
        )}
        <RecentRepos
          repos={repos}
          home={home}
          picked={picked}
          pending={pending}
          onSelect={setPickedRoot}
          onOpen={openRepo}
        />
        {searchable && matches.length === 0 && (
          <p data-testid="welcome-repos-none" className="px-2 text-meta text-muted-foreground">
            No repository matches “{query.trim()}”. Add it below.
          </p>
        )}
        {matches.length > repos.length && (
          <p data-testid="welcome-repos-more" className="px-2 text-meta text-muted-foreground">
            {matches.length - repos.length} more. Type to narrow the list.
          </p>
        )}
        {/* Whether the agents can run, beside the action that starts them. */}
        <AgentStrip />
        <div className="flex flex-wrap items-center gap-2">
          {/* The one primary action: open the picked repository, or with none to pick, a folder. */}
          {picked !== undefined && (
            <Button
              type="button"
              size="sm"
              data-testid="welcome-open"
              disabled={pending !== undefined}
              onClick={() => openRepo(picked)}
            >
              {pending === picked.root ? (
                <Spinner aria-hidden data-icon="inline-start" />
              ) : (
                <FolderGit2 data-icon="inline-start" />
              )}
              Open {picked.name}
              <ArrowRight data-icon="inline-end" />
            </Button>
          )}
          {picked !== undefined && <RunsWith />}
          {picked === undefined ? (
            // Nothing to pick: the other sources are the way in, so they stand on their own.
            <>
              <Button
                type="button"
                size="sm"
                data-testid="welcome-open-folder"
                disabled={pending !== undefined}
                onClick={() => void chooseFolder()}
              >
                <FolderOpen data-icon="inline-start" />
                Open a folder…
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
            </>
          ) : (
            <AddRepositoryMenu
              disabled={pending !== undefined}
              onFolder={() => void chooseFolder()}
              onClone={() => setAdding(true)}
            />
          )}
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
          <p role="alert" className="text-meta text-destructive">
            {error}
          </p>
        )}
      </div>
      <HowItWorks />
      <ImportSessions />
    </section>
  );
}

/**
 * How Gram works, folded under the start: the line under the heading says what a workspace and
 * its orchestrator are, so the three steps (who gives the work, who plans it and who does it) are
 * there for whoever wants them, each with its fuller line.
 */
function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        data-testid="welcome-how"
        className="-ml-2.5 self-start"
        onClick={() => setOpen((was) => !was)}
      >
        <ChevronRight
          data-icon="inline-start"
          className={cn("transition-transform duration-(--dur-fast)", open && "rotate-90")}
        />
        How it works
      </Button>
      <Expand open={open}>
        {open && (
          <ol
            aria-label="How Gram works"
            data-testid="welcome-steps"
            className="flex flex-col gap-2 text-meta"
          >
            {STEPS.map(({ icon: Icon, short, line }) => (
              <li key={short} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2">
                <Icon aria-hidden className="mt-0.5 size-icon-row text-muted-foreground" />
                <span className="flex flex-col">
                  <span className="font-medium text-foreground">{short}</span>
                  <span className="text-muted-foreground">{line}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Expand>
    </div>
  );
}

/**
 * The first run's other ways in, behind one named action beside Open: a folder on disk, or a clone
 * from GitHub, which unfolds its form under the row.
 */
function AddRepositoryMenu({
  disabled,
  onFolder,
  onClone,
}: {
  disabled: boolean;
  onFolder: () => void;
  onClone: () => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        data-testid="welcome-add"
        render={<Button type="button" variant="outline" size="sm" />}
      >
        <Plus data-icon="inline-start" />
        Add repository
        <ChevronDown data-icon="inline-end" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} className="isolate z-50">
          <Menu.Popup className={MENU_POPUP}>
            <Menu.Item className={MENU_ITEM} data-testid="welcome-open-folder" onClick={onFolder}>
              <FolderOpen aria-hidden />
              Open a folder…
            </Menu.Item>
            <Menu.Item className={MENU_ITEM} data-testid="welcome-clone" onClick={onClone}>
              <Globe aria-hidden />
              Clone from GitHub
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * The first run's repository search, once there are more than fit: focused as the card opens, so
 * typing narrows the list at once. Down moves into the list, Return opens the best match.
 */
function RepoSearch({
  query,
  total,
  listed,
  onQuery,
  onOpen,
}: {
  query: string;
  total: number;
  /** Whether the list it narrows is on the page, which it controls. */
  listed: boolean;
  onQuery: (query: string) => void;
  onOpen: () => void;
}) {
  // It mounts once the repositories have loaded: focused then only if focus is nowhere else.
  const focusFree = useCallback((input: HTMLInputElement | null) => {
    if (input !== null && focusLost()) input.focus();
  }, []);
  return (
    <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 text-meta focus-within:focus-ring">
      <Search aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
      <input
        ref={focusFree}
        type="search"
        data-testid="welcome-repo-search"
        aria-label="Find a repository"
        aria-controls={listed ? "welcome-repos" : undefined}
        placeholder={`Find a repository among ${total}`}
        value={query}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            document
              .querySelector<HTMLElement>('#welcome-repos [role=radio][aria-checked="true"]')
              ?.focus();
          } else if (event.key === "Enter") {
            event.preventDefault();
            onOpen();
          } else if (event.key === "Escape" && query !== "") {
            event.preventDefault();
            event.stopPropagation();
            onQuery("");
          }
        }}
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
    </label>
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
  const all = data?.repos ?? [];
  return { projects, all, repos: all.slice(0, RECENT_LIMIT) };
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
        <span className="text-meta text-muted-foreground">
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
                    className="rounded-md border border-border px-2 py-0.5 text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring aria-checked:choice-selected"
                  >
                    {repo.name}
                  </button>
                ))}
              </div>
            )}
            {folder === undefined ? (
              <p className="text-meta text-muted-foreground">
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

/**
 * The repositories Gram knows or finds in the default and clone folders, as one choice: a click or
 * the arrow keys pick one, and Open below (or a double-click, or Return) starts on it.
 */
function RecentRepos({
  repos,
  home,
  picked,
  pending,
  onSelect,
  onOpen,
}: {
  repos: readonly RepositoryCandidate[];
  home: string | undefined;
  picked: RepositoryCandidate | undefined;
  pending: string | undefined;
  onSelect: (root: string) => void;
  onOpen: (repo: RepositoryCandidate) => void;
}) {
  if (repos.length === 0) return null;
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (event.key === "Enter") {
      event.preventDefault();
      onOpen(repos[index]!);
      return;
    }
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + repos.length) % repos.length;
    onSelect(repos[next]!.root);
    const list = event.currentTarget.closest("[role=radiogroup]");
    list?.querySelectorAll<HTMLElement>("[role=radio]")[next]?.focus();
  };
  return (
    <div
      id="welcome-repos"
      role="radiogroup"
      aria-label="Repositories"
      data-testid="welcome-repos"
      className="flex flex-col gap-0.5"
    >
      {repos.map((repo, index) => {
        const checked = repo.root === picked?.root;
        return (
          <button
            key={repo.projectId ?? repo.root}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-testid="welcome-repo"
            disabled={pending !== undefined}
            onClick={() => onSelect(repo.root)}
            onDoubleClick={() => onOpen(repo)}
            onKeyDown={(event) => move(event, index)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:row-cursor focus-visible:focus-ring-inset disabled:opacity-60 aria-checked:choice-selected"
          >
            {pending === repo.root ? (
              <Spinner aria-hidden className="size-icon-row shrink-0" />
            ) : (
              <FolderGit2 aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
            )}
            <span className="shrink-0 font-medium whitespace-nowrap">{repo.name}</span>
            <span className="min-w-0 truncate font-mono text-meta text-muted-foreground">
              {tildify(repo.root, home)}
            </span>
            <ChoiceCheck checked={checked} className="ml-auto" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Beside Open, the agent its work runs on ("Runs with Codex"), or with none ready, what to do
 * first. Reads the same launch checks as the strip above, while they load says nothing.
 */
function RunsWith() {
  const { checks } = useLaunchChecks();
  if (checks === undefined) return null;
  const { ready, agents, words } = runsWith(toolRows(checks));
  return (
    <span
      data-testid="welcome-runs-with"
      data-ready={ready}
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-meta",
        ready ? "text-muted-foreground" : "text-warning",
      )}
    >
      {ready ? (
        agents.map((agent) => <AgentIcon key={agent} agent={agent} className="size-icon-row" />)
      ) : (
        <CircleAlert aria-hidden className="size-icon-row shrink-0" />
      )}
      {words}
    </span>
  );
}

/** How each state reads beside its icon: never by colour alone. */
const STATE: Readonly<Record<ToolState, { icon: LucideIcon; words: string; className: string }>> = {
  ready: { icon: CircleCheck, words: "Ready", className: "text-success" },
  attention: { icon: CircleAlert, words: "Needs sign-in", className: "text-warning" },
  missing: { icon: CircleX, words: "Not installed", className: "text-destructive" },
  optional: { icon: Circle, words: "Not installed", className: "text-muted-foreground" },
};

/**
 * Claude Code and Codex, each ready or not, from the launch checks Settings → Agents reads; git
 * only when it is missing. One that isn't installed links to its install instructions; one that
 * isn't ready offers Check again, which runs the checks once more. Only reads the checks. The
 * version or the remedy is on each name's hover and focus.
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
  const again = () => {
    setChecking(true);
    recheck()
      .catch((error: unknown) => console.error("welcome: re-check tools", error))
      .finally(() => setChecking(false));
  };
  return (
    <div data-testid="welcome-agents" className="rounded-md bg-accent/60 px-3 py-1.5 text-meta">
      {checks === undefined ? (
        <span role="status" className="block py-1 text-muted-foreground">
          Checking your agents…
        </span>
      ) : (
        <ul aria-label="Agents" className="flex flex-col">
          {rows.map((row) => {
            const state = STATE[row.state];
            const Icon = state.icon;
            const words = row.tool === "git" ? "Not installed" : state.words;
            return (
              <li
                key={row.tool}
                data-state={row.state}
                data-tool={row.tool}
                className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 py-0.5"
              >
                <Hint
                  label={<CommandText text={row.detail} />}
                  render={
                    <span
                      // Focusable, so the version or the remedy behind it reaches the keyboard too.
                      tabIndex={0}
                      className="flex items-center gap-1.5 rounded-sm outline-none focus-visible:focus-ring"
                    />
                  }
                >
                  {row.tool === "git" ? (
                    <FolderGit2 aria-hidden className="size-icon-row text-muted-foreground" />
                  ) : (
                    <AgentIcon agent={row.tool} className="size-icon-row" />
                  )}
                  <span className="font-medium">{row.name}</span>
                  <Icon aria-hidden className={cn("ml-1 size-icon-row", state.className)} />
                  <span
                    className={row.state === "ready" ? "text-foreground" : "text-muted-foreground"}
                  >
                    {words}
                  </span>
                  <span className="sr-only">: {row.detail.replaceAll("`", "")}</span>
                </Hint>
                {row.state !== "ready" && (
                  <span className="ml-auto flex items-center gap-1">
                    {row.installUrl !== undefined && (
                      <OutboundLink
                        href={row.installUrl}
                        title={`How to install ${row.name}`}
                        // Optional, with another agent ready: a quiet link, not a second start.
                        className={buttonVariants({
                          size: "xs",
                          variant: row.state === "optional" ? "ghost" : "outline",
                          className: row.state === "optional" ? "text-muted-foreground" : undefined,
                        })}
                      >
                        Install {row.name}
                        <ExternalLink data-icon="inline-end" aria-hidden />
                      </OutboundLink>
                    )}
                    <Button size="xs" variant="ghost" disabled={checking} onClick={again}>
                      {checking ? "Checking…" : "Check again"}
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
