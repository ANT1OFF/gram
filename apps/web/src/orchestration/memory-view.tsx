import type {
  DreamId,
  DreamKind,
  MemoryFileInfo,
  MemoryVersionInfo,
  WorkspaceId,
  WorkspaceState,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronRight,
  BookOpenText,
  CircleHelp,
  FilePlus2,
  Network,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { QueryError } from "@/components/not-available";
import { Term } from "@/components/term";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EXPLAIN } from "@/lib/explain";
import { seeTerm } from "@/lib/first-use";
import { agoText } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { Expand, ExpandPresence, NumberTicker, PresenceItem, PresenceList, Swap } from "@/motion";
import { PanelMessage } from "@/panels/panel-message";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { formatBytes } from "@/thread/orchestration-model";

import { DreamsSection } from "./dreams-section";
import { InlineConfirm } from "./inline-confirm";
import { MemoryOverview } from "./memory-overview";
import {
  memoryCapFor,
  memoryIsEmpty,
  memoryPathProblem,
  memorySize,
  QUESTIONS_FILE,
} from "./memory-model";
import { useOpenBoard } from "./open-board";
import { ClosedQuestion, OpenQuestionList } from "./question-entry";
import { useQuestions } from "./use-board-actions";
import { useFocusOnOpen } from "./use-focus-on-open";
import { useWorkspacesQuery } from "./use-orchestration";

const SECTION = "flex flex-col gap-3 rounded-(--radius-md) border border-border bg-card/40 p-3";
/** A tab's one line on what it is for, beside its action. */
const LEAD = "min-w-0 flex-1 text-meta text-muted-foreground";
/** A size beside its cap, the cap as short as it reads: 32 KB, not 32.0 KB. */
const capText = (cap: number): string => `${cap / 1024} KB`;
const INPUT =
  "rounded-md border border-input bg-transparent px-2 text-reading outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * The questions the orchestrator left for the user: the open ones answerable here, then a fold of
 * the closed ones with how each was closed, which is left out while there are none.
 */
function Questions({ state }: { state: WorkspaceState }) {
  const all = useQuestions(state.workspace.id);
  const open = all.filter((question) => question.open);
  const closed = all.filter((question) => !question.open);
  const [showClosed, setShowClosed] = useState(false);
  const closedId = useId();
  // Asked of the threads store, as the slot may name a thread that has since been closed.
  const orchestratorId = useThreadsStore((s) =>
    state.workspace.orchestratorThreadId !== undefined &&
    s.byId[state.workspace.orchestratorThreadId] !== undefined
      ? state.workspace.orchestratorThreadId
      : undefined,
  );
  return (
    <section
      id="questions"
      aria-label="Decisions to make"
      data-testid="memory-questions"
      className={SECTION}
    >
      <h2 className="sr-only">Decisions to make</h2>
      <p className={LEAD}>
        {open.length === 0 ? (
          <>
            None. The orchestrator asks with <code>ask_user</code>, keeps its questions in{" "}
            {QUESTIONS_FILE}, and open ones show here.
          </>
        ) : (
          <>
            <CircleHelp
              aria-hidden
              className="me-1 inline size-3.5 align-[-2px] text-status-needs-mark"
            />
            The orchestrator is waiting on{" "}
            <span className="tabular-nums">
              <NumberTicker value={open.length} />
            </span>{" "}
            {open.length === 1 ? "answer" : "answers"} from you. Each goes straight to it.
          </>
        )}
      </p>
      {open.length > 0 && (
        <OpenQuestionList
          questions={open}
          workspaceId={state.workspace.id}
          orchestratorId={orchestratorId}
        />
      )}
      {closed.length > 0 && (
        <div data-testid="memory-closed-questions" className="border-t border-border pt-2">
          <button
            type="button"
            aria-expanded={showClosed}
            aria-controls={closedId}
            onClick={() => setShowClosed((was) => !was)}
            className="flex items-center gap-1 rounded-sm text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3 transition-transform duration-(--dur-fast)",
                showClosed && "rotate-90",
              )}
            />
            Closed
            <span className="tabular-nums">{closed.length}</span>
          </button>
          <Expand open={showClosed} id={closedId}>
            <ul className="flex flex-col gap-2 pt-2">
              {closed.map((question, index) => (
                <ClosedQuestion
                  key={question.id ?? `${index}:${question.text}`}
                  question={question}
                />
              ))}
            </ul>
          </Expand>
        </div>
      )}
    </section>
  );
}

/** The editor for one memory file: a plain textarea, the cap it is held to, and its three actions. */
function FileEditor({
  workspaceId,
  path,
  onDeleted,
}: {
  workspaceId: WorkspaceId;
  path: string;
  onDeleted: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const file = useQuery({
    queryKey: ["memory", workspaceId, "file", path],
    queryFn: () => api.readMemory(workspaceId, path),
    retry: false,
  });
  const loaded = file.data?.content;
  const [draft, setDraft] = useState<string>();
  // What the draft was started from: when memory moves on under an untouched draft it follows, and
  // under an edited one it stays, with a word that saving will overwrite what is there now.
  const [base, setBase] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(0);
  if (loaded !== undefined && (draft === undefined || (draft === base && loaded !== base))) {
    setDraft(loaded);
    setBase(loaded);
  }
  const text = draft ?? "";
  const dirty = draft !== undefined && draft !== base;
  const movedUnder = dirty && loaded !== undefined && loaded !== base;
  const size = memorySize(path, text);

  const run = (what: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    setError(undefined);
    what()
      .then(async () => {
        after();
        await queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] });
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  if (file.error) return <QueryError error={file.error} feature={path} />;
  if (draft === undefined) return <PanelMessage loading>Reading {path}…</PanelMessage>;

  return (
    <div
      data-testid="memory-editor"
      data-path={path}
      className="flex min-w-0 flex-1 flex-col gap-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="font-mono text-reading">{path}</h3>
        <span
          data-testid="memory-size"
          data-over={size.over}
          className={cn(
            "text-meta tabular-nums",
            size.over ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {formatBytes(size.bytes)} of {formatBytes(size.cap)}
          {size.over && " — too large to save"}
        </span>
        {saved > 0 && !dirty && (
          <span key={saved} className="gram-fade text-meta text-success">
            Saved
          </span>
        )}
      </div>
      <textarea
        aria-label={`Contents of ${path}`}
        data-testid="memory-text"
        spellCheck={false}
        className={cn(INPUT, "min-h-64 flex-1 resize-y py-1.5 font-mono text-meta leading-5")}
        value={text}
        onChange={(event) => setDraft(event.target.value)}
      />
      {movedUnder && (
        <p role="status" className="text-meta text-warning">
          This file changed in memory since you started editing. Saving overwrites what is there
          now; Revert shows it.
        </p>
      )}
      {error !== undefined && (
        <p role="alert" data-testid="memory-error" className="text-meta text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          // A quiet outline until there is something to save, so it never looks ready when it isn't.
          variant={dirty && !size.over ? "default" : "outline"}
          data-testid="memory-save"
          disabled={busy || !dirty || size.over}
          onClick={() =>
            run(
              () => api.writeMemory(workspaceId, path, text),
              () => {
                // Ahead of the refetch, or the editor would follow the stale read back to the old text.
                queryClient.setQueryData(["memory", workspaceId, "file", path], {
                  path,
                  content: text,
                });
                setBase(text);
                setSaved((n) => n + 1);
              },
            )
          }
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !dirty}
          onClick={() => {
            setDraft(loaded);
            setBase(loaded);
            setError(undefined);
          }}
        >
          Revert
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-destructive hover:text-destructive"
          data-testid="memory-delete"
          aria-expanded={confirming}
          disabled={busy}
          onClick={() => setConfirming(!confirming)}
        >
          Delete
        </Button>
      </div>
      <InlineConfirm
        open={confirming}
        label={`Delete ${path}?`}
        confirmLabel="Delete file"
        destructive
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          run(
            () => api.deleteMemory(workspaceId, path),
            () => {
              setConfirming(false);
              onDeleted();
            },
          )
        }
      >
        Delete {path} from memory? The orchestrator stops seeing it at once. The last adopted
        version still has it, under History.
      </InlineConfirm>
    </div>
  );
}

/** Names a new file; it exists once its first save goes through. */
function NewFileForm({
  existing,
  onCreate,
  onCancel,
}: {
  existing: readonly string[];
  onCreate: (path: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const focus = useFocusOnOpen<HTMLInputElement>();
  const id = useId();
  return (
    <form
      aria-label="New memory file"
      data-testid="memory-new-form"
      className="flex flex-col gap-1.5 pt-1"
      onSubmit={(event) => {
        event.preventDefault();
        const name = path.trim();
        const problem = memoryPathProblem(name, existing);
        if (problem !== undefined) return setError(problem);
        setBusy(true);
        onCreate(name)
          .catch((e: unknown) => setError(errorMessage(e)))
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor={id} className="text-meta text-muted-foreground">
        A Markdown file, at most two folders deep
      </label>
      <input
        id={id}
        ref={focus}
        spellCheck={false}
        className={cn(INPUT, "h-7 font-mono text-meta")}
        value={path}
        placeholder="repos/gram.md"
        onChange={(event) => {
          setPath(event.target.value);
          setError(undefined);
        }}
      />
      {error !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={busy}>
          Create
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Files({
  workspaceId,
  files,
  selected,
  onSelect: setSelected,
}: {
  workspaceId: WorkspaceId;
  files: readonly MemoryFileInfo[];
  /** The file open in the editor, which Current memory's Edit can choose. */
  selected: string | undefined;
  onSelect: (path: string | undefined) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const now = useNow(true, ref, 60_000);
  const paths = files.map((file) => file.path);
  const open = selected !== undefined && paths.includes(selected) ? selected : undefined;

  return (
    <section ref={ref} aria-label="Memory files" data-testid="memory-files" className={SECTION}>
      <h2 className="sr-only">Files</h2>
      <div className="flex flex-wrap items-center gap-2">
        <p className={LEAD}>
          What the orchestrator starts every session from. It writes here as it learns; so can you.
        </p>
        <Button
          size="xs"
          variant="outline"
          data-testid="memory-new"
          aria-expanded={creating}
          onClick={() => setCreating(!creating)}
        >
          <FilePlus2 data-icon="inline-start" />
          New file
        </Button>
      </div>
      <ExpandPresence open={creating}>
        <NewFileForm
          existing={paths}
          onCancel={() => setCreating(false)}
          onCreate={async (path) => {
            await api.writeMemory(workspaceId, path, `# ${path.replace(/\.md$/, "")}\n`);
            await queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] });
            setCreating(false);
            setSelected(path);
          }}
        />
      </ExpandPresence>
      <div className="flex min-w-0 flex-col gap-3 md:flex-row">
        <ul aria-label="Files" className="flex shrink-0 flex-col gap-0.5 md:w-56">
          <PresenceList>
            {files.map((file) => (
              <PresenceItem as="li" key={file.path} glide>
                <button
                  type="button"
                  data-testid="memory-file"
                  data-path={file.path}
                  aria-current={open === file.path ? "true" : undefined}
                  onClick={() => setSelected(file.path)}
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded-(--radius-sm) px-2 py-1 text-left text-meta outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring",
                    open === file.path && "bg-sidebar-row-active",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                  {/* Its size and cap are file details, shown above the editor; only a file
                      already too large to save says so here. */}
                  {file.bytes > memoryCapFor(file.path) && (
                    <span
                      data-testid="memory-file-size"
                      title={`${formatBytes(file.bytes)} of the ${capText(memoryCapFor(file.path))} this file may hold`}
                      className="shrink-0 text-destructive"
                    >
                      over cap
                    </span>
                  )}
                  <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
                    {agoText(file.modifiedAt, now).replace(" ago", "")}
                  </span>
                </button>
              </PresenceItem>
            ))}
          </PresenceList>
          {files.length === 0 && (
            <li className="px-2 py-1 text-meta text-muted-foreground">No files yet.</li>
          )}
        </ul>
        {open === undefined ? (
          <p className="flex-1 self-center text-center text-meta text-muted-foreground">
            {files.length === 0 ? "Memory is empty." : "Pick a file to read or edit it."}
          </p>
        ) : (
          <FileEditor
            key={open}
            workspaceId={workspaceId}
            path={open}
            onDeleted={() => setSelected(undefined)}
          />
        )}
      </div>
    </section>
  );
}

function VersionRow({
  workspaceId,
  version,
  now,
}: {
  workspaceId: WorkspaceId;
  version: MemoryVersionInfo;
  now: number;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <li data-testid="memory-version" data-version={version.version} className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-meta">
        <span className="font-mono text-reading">{version.version}</span>
        <span className="text-muted-foreground">adopted {agoText(version.adoptedAt, now)}</span>
        <span className="text-muted-foreground tabular-nums">
          {version.files} {version.files === 1 ? "file" : "files"}
        </span>
        <Swap swapKey={version.current ? "current" : "kept"} className="ml-auto items-center">
          {version.current ? (
            <span
              data-testid="memory-version-current"
              className="rounded-sm border border-success/50 px-1 text-success"
            >
              Current
            </span>
          ) : (
            <Button
              size="xs"
              variant="outline"
              aria-expanded={confirming}
              onClick={() => setConfirming(!confirming)}
            >
              Restore
            </Button>
          )}
        </Swap>
      </div>
      <InlineConfirm
        open={confirming && !version.current}
        label={`Restore version ${version.version}?`}
        confirmLabel={`Restore ${version.version}`}
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setBusy(true);
          setError(undefined);
          api
            .restoreMemory(workspaceId, version.version)
            .then(() => {
              setConfirming(false);
              return queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] });
            })
            .catch((e: unknown) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        Point memory back at version {version.version}? Nothing is copied or deleted: the version
        that is current now stays in this list, and the orchestrator reads {version.version} from
        its next digest.
      </InlineConfirm>
      {error !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

function Versions({ workspaceId }: { workspaceId: WorkspaceId }) {
  const api = useApi();
  const ref = useRef<HTMLElement>(null);
  const now = useNow(true, ref, 60_000);
  const versions = useQuery({
    queryKey: ["memory", workspaceId, "versions"],
    queryFn: () => api.listMemoryVersions(workspaceId),
    retry: false,
  });
  return (
    <section ref={ref} aria-label="Versions" data-testid="memory-versions" className={SECTION}>
      <h2 className="sr-only">Versions</h2>
      <p className={LEAD}>
        Each adopted update makes a new version of memory. The last few are kept, so an update you
        regret is one Restore away.
      </p>
      {versions.error ? (
        <QueryError error={versions.error} feature="Memory versions" />
      ) : (
        <ul className="flex flex-col gap-2">
          {(versions.data ?? []).toReversed().map((version) => (
            <VersionRow
              key={version.version}
              workspaceId={workspaceId}
              version={version}
              now={now}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The Memory view's tabs. */
type MemoryTab = "overview" | "files" | "decisions" | "history" | "update";

/**
 * Draft memory update's mark on its tab: amber while a finished run waits for your review, the working
 * colour while one runs, nothing otherwise.
 */
function UpdateTabMark({ workspaceId }: { workspaceId: WorkspaceId }) {
  const api = useApi();
  const dreams = useQuery({
    queryKey: ["dreams", workspaceId, "list"],
    queryFn: () => api.listDreams(workspaceId),
    retry: false,
  });
  const list = dreams.data ?? [];
  const waiting = list.filter(
    (dream) =>
      dream.status === "completed" &&
      dream.adoptedVersion === undefined &&
      // An Auto run waits on nobody, unless its adoption stopped and handed it to you.
      (dream.mode !== "auto" || dream.adoptionFailure !== undefined),
  ).length;
  const running = list.some((dream) => dream.status === "running" || dream.status === "pending");
  if (waiting > 0) {
    return (
      <span
        data-testid="memory-tab-update-waiting"
        className="ms-1.5 inline-flex items-center gap-1 font-normal text-status-needs tabular-nums"
      >
        <span aria-hidden className="size-1.5 rounded-full bg-status-needs-mark" />
        {waiting}
        <span className="sr-only"> to review</span>
      </span>
    );
  }
  if (running) {
    return (
      <span
        aria-label="running"
        className="ms-1.5 inline-block size-1.5 rounded-full bg-status-working"
      />
    );
  }
  return null;
}

/**
 * A workspace's memory, in five tabs: what it holds now, rendered to read; the files it starts
 * every session from, to edit; the questions the orchestrator left open; the versions kept; and
 * the runs (Dreams) that draft updates to it. Reached
 * from the board and from the orchestrator's banner; a page of its own because the right panel's
 * tabs are a contract, and this belongs to a workspace rather than to the thread the panel follows.
 */
export function MemoryView({
  workspaceId,
  reviewing,
}: {
  workspaceId: WorkspaceId;
  reviewing: DreamId | undefined;
}) {
  const api = useApi();
  const openBoard = useOpenBoard();
  const { workspaces, settled, error } = useWorkspacesQuery();
  const state = workspaces.find((candidate) => candidate.workspace.id === workspaceId);
  const files = useQuery({
    queryKey: ["memory", workspaceId, "files"],
    queryFn: () => api.listMemory(workspaceId),
    enabled: state !== undefined,
    retry: false,
  });
  const [starting, setStarting] = useState<DreamKind>();
  // A dream's review opens on Draft memory update, and `#questions` from the board's chip on Decisions.
  const [tab, setTab] = useState<MemoryTab>(() =>
    reviewing !== undefined
      ? "update"
      : window.location.hash === "#questions"
        ? "decisions"
        : "overview",
  );
  // The file open in Files, which Current memory's Edit opens there.
  const [openFile, setOpenFile] = useState<string>();
  const [reviewingSeen, setReviewingSeen] = useState(reviewing);
  if (reviewing !== reviewingSeen) {
    setReviewingSeen(reviewing);
    if (reviewing !== undefined) setTab("update");
  }
  const openQuestions = useQuestions(workspaceId).filter((question) => question.open).length;
  // The section exists only once the workspace has loaded.
  const ready = state !== undefined;
  useEffect(() => {
    if (ready && window.location.hash === "#questions") {
      document.getElementById("questions")?.scrollIntoView({ block: "start" });
    }
  }, [ready]);

  if (!settled) return <PanelMessage loading>Loading memory…</PanelMessage>;
  if (error) return <QueryError error={error} feature="Memory" />;
  if (state === undefined) {
    return (
      <div
        role="status"
        data-testid="memory-missing"
        className="flex flex-col items-center gap-2 p-8 text-center text-reading text-muted-foreground"
      >
        <BookOpenText aria-hidden className="size-5" />
        <p>No such workspace.</p>
        <p className="max-w-sm text-meta">
          It may have been removed. Workspaces are in{" "}
          <Link to="/settings/workspaces" className="underline hover:text-foreground">
            Settings → Workspaces
          </Link>
          .
        </p>
      </div>
    );
  }

  const orchestratorId = state.workspace.orchestratorThreadId;
  const empty = files.data !== undefined && memoryIsEmpty(files.data);
  // Keep an inline review's scrollable content from extending the root document's scroll range.
  return (
    <div
      data-testid="memory-view"
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-y-auto",
        reviewing !== undefined && "contain-paint",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3">
        <h1 className="flex min-w-0 items-center gap-2 text-title">
          <BookOpenText aria-hidden className="size-4 shrink-0 text-primary" />
          <span className="truncate">Memory · {state.workspace.name}</span>
        </h1>
        <div className="ml-auto flex items-center gap-2">
          {orchestratorId !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="memory-orchestrator"
              nativeButton={false}
              render={
                <Link
                  to="/t/$threadId"
                  params={{ threadId: orchestratorId }}
                  onClick={() => useLayoutStore.getState().openThread(orchestratorId)}
                />
              }
            >
              <Network data-icon="inline-start" />
              Orchestrator
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            data-testid="memory-board"
            onClick={() => openBoard(workspaceId)}
          >
            <ArrowLeft data-icon="inline-start" />
            Board
          </Button>
        </div>
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as MemoryTab)}
        // Its own height, so the tab bar stays stuck over the whole of a long tab.
        className="flex-none"
      >
        <TabsList
          aria-label="Memory"
          data-testid="memory-tabs"
          className="sticky top-0 z-10 bg-thread px-4"
        >
          <TabsTrigger value="overview" data-testid="memory-tab-overview">
            Current memory
          </TabsTrigger>
          <TabsTrigger value="files" data-testid="memory-tab-files">
            Files
            {files.data !== undefined && (
              <span className="ms-1 font-normal text-muted-foreground tabular-nums">
                {files.data.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="decisions" data-testid="memory-tab-decisions">
            Decisions
            {openQuestions > 0 && (
              <span className="ms-1.5 inline-flex items-center gap-1 font-normal text-status-needs tabular-nums">
                <span aria-hidden className="size-1.5 rounded-full bg-status-needs-mark" />
                {openQuestions}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" data-testid="memory-tab-history">
            History
          </TabsTrigger>
          {/* Dreams' tab, explained on hover: what a draft is, and that memory waits for adopting it. */}
          <Hint
            label={EXPLAIN.dreams}
            side="bottom"
            delay={300}
            onOpenChange={(open) => {
              if (open) seeTerm("dreams");
            }}
            render={<TabsTrigger value="update" data-testid="memory-tab-update" />}
          >
            <Term term="dreams">Draft memory update</Term>
            <UpdateTabMark workspaceId={workspaceId} />
          </Hint>
        </TabsList>
        <div className="flex flex-col gap-3 p-4">
          {empty && starting === undefined && tab !== "update" && (
            <p
              data-testid="memory-import-offer"
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground"
            >
              This workspace's memory is empty. Draft it from your past sessions in these repos; you
              see what it would read, and what that costs, before anything runs.
              <button
                type="button"
                className="rounded-sm text-foreground underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setStarting("import");
                  setTab("update");
                }}
              >
                Draft from past sessions…
              </button>
            </p>
          )}
          {/* Mounted only while chosen: left to the tabs, a switch made while its Markdown is still
              settling kept this tall panel mounted above the next one, which then opened far
              down the page. */}
          {tab === "overview" && (
            <TabsContent value="overview">
              {files.error ? (
                <QueryError error={files.error} feature="Memory" />
              ) : files.data === undefined ? (
                <PanelMessage loading>Reading memory…</PanelMessage>
              ) : (
                <MemoryOverview
                  workspaceId={workspaceId}
                  files={files.data}
                  onOpen={(path) => {
                    setOpenFile(path);
                    setTab("files");
                  }}
                />
              )}
            </TabsContent>
          )}
          <TabsContent value="files">
            {files.error ? (
              <QueryError error={files.error} feature="Memory" />
            ) : files.data === undefined ? (
              <PanelMessage loading>Reading memory…</PanelMessage>
            ) : (
              <Files
                workspaceId={workspaceId}
                files={files.data}
                selected={openFile}
                onSelect={setOpenFile}
              />
            )}
          </TabsContent>
          <TabsContent value="decisions">
            <Questions state={state} />
          </TabsContent>
          <TabsContent value="history">
            <Versions workspaceId={workspaceId} />
          </TabsContent>
          <TabsContent value="update">
            <DreamsSection
              state={state}
              reviewing={reviewing}
              starting={starting}
              onStartingChange={setStarting}
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
