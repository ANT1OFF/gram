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
  GitBranch,
  GitPullRequest,
  Globe,
  MessageSquare,
  Network,
  Plus,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useState, type KeyboardEvent, type ReactNode } from "react";

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
import { ResumeSessions } from "@/resume/resume-sessions";
import { useSaveSettings } from "@/settings/use-save-settings";

import { matchRepos, RECENT_LIMIT } from "./repo-search";
import { runsWith, toolRows, type ToolRow, type ToolState } from "./tools";
import { useFirstRun, useWelcome } from "./welcome-state";

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
    line: "One per workspace. It starts by surveying your repositories and suggesting first tasks, then splits each task into pieces and follows them through.",
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

  const skip = () => {
    useWelcome.setState({ open: false });
    void record();
  };

  return (
    <section
      aria-labelledby="welcome-title"
      data-testid="welcome"
      className="flex w-full max-w-2xl flex-col gap-5 rounded-xl border border-edge bg-card p-6 text-reading text-card-foreground shadow-raised"
    >
      <div className="flex flex-col gap-1">
        <h2 id="welcome-title" className="font-heading text-heading">
          Open a repository
        </h2>
        <p data-testid="welcome-line" className="text-reading text-muted-foreground">
          Gram makes it a workspace, whose orchestrator hands your tasks to agents and follows each
          one to a pull request.
        </p>
      </div>
      <div className="flex flex-col gap-2">
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
          <p data-testid="welcome-repos-none" className="px-3 text-meta text-muted-foreground">
            No repository matches “{query.trim()}”. Add it below.
          </p>
        )}
        {matches.length > repos.length && (
          <p data-testid="welcome-repos-more" className="px-3 text-meta text-muted-foreground">
            {matches.length - repos.length} more. Type to narrow the list.
          </p>
        )}
        {picked !== undefined && (
          // Another way in, quiet under the list it adds to: a folder, or a clone from GitHub.
          <AddRepositoryMenu
            disabled={pending !== undefined}
            onFolder={() => void chooseFolder()}
            onClone={() => setAdding(true)}
          />
        )}
        <Expand open={adding}>
          {adding && <AddRepository onAdded={(project) => start(project)} />}
        </Expand>
      </div>
      <div className="flex flex-col gap-3">
        {/* The one primary action with Skip beside it as the secondary one, the agents under them. */}
        <div data-testid="welcome-actions" className="flex flex-wrap items-center gap-2">
          {picked !== undefined ? (
            <Button
              type="button"
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
          ) : (
            // Nothing to pick: a folder on disk is the way in, a clone the other.
            <>
              <Button
                type="button"
                data-testid="welcome-open-folder"
                disabled={pending !== undefined}
                onClick={() => void chooseFolder()}
              >
                <FolderOpen data-icon="inline-start" />
                Open a folder…
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-expanded={adding}
                disabled={pending !== undefined}
                onClick={() => setAdding((open) => !open)}
              >
                <Globe data-icon="inline-start" />
                Clone from GitHub
              </Button>
            </>
          )}
          <Button
            type="button"
            variant={picked === undefined ? "ghost" : "outline"}
            data-testid="welcome-skip"
            onClick={skip}
          >
            Skip
          </Button>
        </div>
        {error !== undefined && (
          <p role="alert" className="text-meta text-destructive">
            {error}
          </p>
        )}
        <Readiness />
        {picked !== undefined && (
          // What Open leads to, so the first click holds no surprise, and that the survey comes next.
          <p data-testid="welcome-next" className="text-meta text-muted-foreground">
            Next: choose how much it may do on its own. Its orchestrator then surveys {picked.name}{" "}
            and suggests first tasks; nothing starts until you pick one.
          </p>
        )}
      </div>
      <MoreAboutGram />
    </section>
  );
}

/** The footer's two folds: how Gram works, and past CLI sessions to pick up. */
type More = "how" | "import";

/**
 * Under the start, folded until asked for: how Gram works, in three rows (who gives the work, who
 * plans it and who does it), and past CLI sessions to import. One row of two disclosures, so the
 * first screen is the repository, the agent and Open.
 */
function MoreAboutGram() {
  const [open, setOpen] = useState<More>();
  const toggle = (which: More) => setOpen((was) => (was === which ? undefined : which));
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="-ml-2.5 flex flex-wrap items-center gap-1">
        <Disclosure
          open={open === "how"}
          testId="welcome-how"
          onClick={() => toggle("how")}
          label="How it works"
        />
        <Disclosure
          open={open === "import"}
          testId="welcome-import"
          onClick={() => toggle("import")}
          label="Import past CLI sessions"
        />
      </div>
      <Expand open={open === "how"}>
        {open === "how" && (
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
      <Expand open={open === "import"}>{open === "import" && <ImportSessions />}</Expand>
    </div>
  );
}

function Disclosure({
  open,
  testId,
  label,
  onClick,
}: {
  open: boolean;
  testId: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={open}
      data-testid={testId}
      onClick={onClick}
    >
      <ChevronRight
        data-icon="inline-start"
        className={cn("transition-transform duration-(--dur-fast)", open && "rotate-90")}
      />
      {label}
    </Button>
  );
}

/**
 * The first run's other ways in, behind one quiet action under the list: a folder on disk, or a
 * clone from GitHub, which unfolds its form under it.
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
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start text-muted-foreground"
          />
        }
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
 * first, then its past sessions, as ⌘K's Resume past session lists them. Shown once its fold opens.
 */
function ImportSessions() {
  const { repos } = useFirstRunRepos();
  const [root, setRoot] = useState<string>();
  const folder = root ?? repos[0]?.root;
  return (
    <div data-testid="welcome-import-sessions" className="flex flex-col gap-2">
      <p className="text-meta text-muted-foreground">
        Pick up a Claude Code or Codex session you started in a terminal.
      </p>
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
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left outline-none hover:row-cursor focus-visible:focus-ring-inset disabled:opacity-60 aria-checked:choice-selected"
          >
            {pending === repo.root ? (
              <Spinner aria-hidden className="size-icon-row shrink-0" />
            ) : (
              <FolderGit2 aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
            )}
            <span className="shrink-0 text-body-strong whitespace-nowrap">{repo.name}</span>
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

/** How each state reads beside its icon: never by colour alone. */
const STATE: Readonly<Record<ToolState, { icon: LucideIcon; words: string; className: string }>> = {
  ready: { icon: CircleCheck, words: "Ready", className: "text-success" },
  attention: { icon: CircleAlert, words: "Needs sign-in", className: "text-warning" },
  missing: { icon: CircleX, words: "Not installed", className: "text-destructive" },
  optional: { icon: Circle, words: "Not installed", className: "text-muted-foreground" },
};

/** What the GitHub CLI is for, beside it while it isn't set up: it is optional, not a blocker. */
const GH_FOR = "For pull requests and their checks";

/**
 * Under Open, what its work runs on: "Runs with Codex" when an agent is ready, else the one thing
 * to do first. Under that line, each tool that isn't ready yet: an agent no other covers says how
 * to install or sign in to it, with its install docs; one another agent covers, the GitHub CLI and
 * git when missing stay one quiet row each. Check again runs the checks once more. Only reads them.
 */
function Readiness() {
  const { checks, recheck } = useLaunchChecks();
  const [checking, setChecking] = useState(false);
  if (checks === undefined) {
    return (
      <p role="status" data-testid="welcome-agents" className="text-meta text-muted-foreground">
        Checking your agents…
      </p>
    );
  }
  const all = toolRows(checks);
  const { ready, agents, words } = runsWith(all);
  // The ones still to set up, those that stop the start first; a ready agent is named in the line.
  const rows = all
    .filter((row) => row.state !== "ready")
    .toSorted((a, b) => Number(a.state === "optional") - Number(b.state === "optional"));
  const again = () => {
    setChecking(true);
    recheck()
      .catch((error: unknown) => console.error("welcome: re-check tools", error))
      .finally(() => setChecking(false));
  };
  return (
    <div
      data-testid="welcome-agents"
      data-ready={ready}
      className="flex flex-col gap-1 rounded-md bg-accent/60 px-3 py-2 text-meta"
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
        <span
          data-testid="welcome-runs-with"
          data-ready={ready}
          className={cn(
            "flex min-w-0 items-center gap-1.5 font-medium",
            ready ? "text-foreground" : "text-warning",
          )}
        >
          {ready ? (
            agents.map((agent) => <AgentIcon key={agent} agent={agent} className="size-icon-row" />)
          ) : (
            <CircleAlert aria-hidden className="size-icon-row shrink-0" />
          )}
          {words}
        </span>
        {rows.length > 0 && (
          <Button size="xs" variant="ghost" className="ml-auto" disabled={checking} onClick={again}>
            {checking ? "Checking…" : "Check again"}
          </Button>
        )}
      </div>
      {rows.length > 0 && (
        <ul aria-label="Tools to set up" className="flex flex-col">
          {rows.map((row) => (
            <ToolLine key={row.tool} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One tool that isn't ready. Needed (no other agent covers it, or git): its remedy is spelled out
 * under it, the command marked, with its install docs beside. Optional: one quiet row, the remedy
 * on its hover.
 */
function ToolLine({ row }: { row: ToolRow }) {
  const state = STATE[row.state];
  const Icon = state.icon;
  const needed = row.state === "missing" || row.state === "attention";
  const note = row.tool === "gh" ? GH_FOR : undefined;
  return (
    <li
      data-state={row.state}
      data-tool={row.tool}
      className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-0.5 py-0.5"
    >
      <Hint
        label={<CommandText text={row.detail} />}
        render={
          <span
            // Focusable, so the version or the remedy behind it reaches the keyboard too.
            tabIndex={0}
            className="flex items-center gap-1.5 rounded-sm text-muted-foreground outline-none focus-visible:focus-ring"
          />
        }
      >
        {/* An agent by its own mark; the GitHub CLI by what it is for, git by its branches. */}
        {row.tool === "claude" || row.tool === "codex" ? (
          <AgentIcon agent={row.tool} className="size-icon-row" />
        ) : row.tool === "gh" ? (
          <GitPullRequest aria-hidden className="size-icon-row" />
        ) : (
          <GitBranch aria-hidden className="size-icon-row" />
        )}
        <span className={needed ? "font-medium text-foreground" : undefined}>{row.name}</span>
        <Icon aria-hidden className={cn("ml-1 size-icon-chip", state.className)} />
        <span>{state.words}</span>
        {note !== undefined && <span>· {note}</span>}
        <span className="sr-only">: {row.detail.replaceAll("`", "")}</span>
      </Hint>
      {row.installUrl !== undefined && (
        <OutboundLink
          href={row.installUrl}
          title={`How to install ${row.name}`}
          // Optional, with another agent ready: a quiet link, not a second start.
          className={buttonVariants({
            size: "xs",
            variant: needed ? "outline" : "ghost",
            className: cn("ml-auto", !needed && "text-muted-foreground"),
          })}
        >
          Install {row.name}
          <ExternalLink data-icon="inline-end" aria-hidden />
        </OutboundLink>
      )}
      {needed && (
        <p data-testid="welcome-remedy" className="basis-full pl-5.5 text-muted-foreground">
          <CommandText text={row.detail} />
        </p>
      )}
    </li>
  );
}
