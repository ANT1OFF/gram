import type { Diff, DiffScope, ThreadId, TurnId } from "@gram/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Columns2, GitBranch, GitCompareArrows, History, ListTree, Rows2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";

import { useApi } from "@/api/context";
import { errorMessage, folderProblem } from "@/api/errors";
import { QueryError } from "@/components/not-available";
import { useShortcut } from "@/keyboard/registry";
import { radioGroupKeyDown } from "@/lib/list-keys";
import { useStableSelector } from "@/lib/use-stable";
import { cn } from "@/lib/utils";
import { NumberTicker, SegmentSlab } from "@/motion";
import { useThreadFeed } from "@/stores/feeds";
import { useLayoutStore, type DiffLayout, type PanelTarget } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { useDiffFileActions } from "./diff-file-actions";
import { DiffFileList, type DiffFocus } from "./diff-files";
import { DiffReviewContext, useDiffReviewState } from "./diff-review";
import { DiffTree } from "./diff-tree";
import { buildDiffTree, treeOrder } from "./diff-tree-model";
import { checkoutRelative } from "./files/files-store";
import { FolderMissing } from "./folder-missing";
import { PanelMessage } from "./panel-message";
import { countHunks } from "./patch";
import { RefreshButton } from "./refresh-button";
import { sameTurnOptions, targetTurnId, turnOptions } from "./turn-diff";

const SCOPES = [
  { kind: "uncommitted", label: "Uncommitted" },
  { kind: "branch", label: "Branch" },
  { kind: "turn", label: "Turn" },
] as const;
type ScopeKind = (typeof SCOPES)[number]["kind"];

/** How long a diff whose stamp hasn't moved is shown again on a remount without asking. */
const SWITCH_BACK_FRESH_MS = 30_000;

/** The file list's narrowest width for split view; below it the panel shows unified. */
const SPLIT_VIEW_MIN_WIDTH = 560;
/** The panel's narrowest width with the file tree beside the files rather than above them. */
const TREE_BESIDE_MIN_WIDTH = 720;
/** The file tree's width beside the files: `w-52`. */
const TREE_WIDTH = 208;

const LAYOUTS = [
  { kind: "unified", label: "Unified", icon: Rows2 },
  { kind: "split", label: "Split", icon: Columns2 },
] as const;

/** The element's width, following resizes; 0 until measured. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Tree and hunk jumps count down, so they never collide with an agent request's id. */
let jumpSeq = 0;

/**
 * The thread's working-tree, branch or per-turn diff; refetches whenever `git.state` reports new
 * changes, or on Refresh. A clean working tree on a branch ahead of its base shows the branch instead,
 * with a note. An agent's diff target is focused once the diff has loaded; a `turn:<id>` target
 * selects that turn instead. Unified or split and the file tree are the user's choice, remembered;
 * split falls back to unified while the panel is too narrow for it.
 */
export function DiffPanel({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useWidth(rootRef);
  const scopeSlab = useId();
  const layoutSlab = useId();
  const layout = useLayoutStore((s) => s.diffLayout);
  const setLayout = useLayoutStore((s) => s.setDiffLayout);
  const treeShown = useLayoutStore((s) => s.diffTreeShown);
  const toggleTree = useLayoutStore((s) => s.toggleDiffTree);
  // What the diff is a function of, as the server's `diffToken` has it: the working tree and HEAD,
  // and the base a branch diff (or a clean tree's fallback to one) compares against.
  const diffStamp = useThreadsStore((s) => {
    const git = s.byId[threadId]?.git;
    return git === undefined
      ? null
      : `${git.changesToken}:${git.base ?? ""}:${git.behindBase}:${git.aheadBase}`;
  });
  // The turns, not the messages: a streamed frame that leaves them alone doesn't re-render the diff.
  const turns = useThreadFeed(
    threadId,
    useStableSelector((s) => turnOptions(s.messages), sameTurnOptions),
  );
  const [scope, setScope] = useState<ScopeKind>("uncommitted");
  const [picked, setPicked] = useState<TurnId>();
  const turnId = picked ?? turns[0]?.turnId;
  const diffScope: DiffScope | undefined =
    scope !== "turn"
      ? { kind: scope }
      : turnId === undefined
        ? undefined
        : { kind: "turn", turnId };
  const query = useQuery({
    queryKey: ["git.diff", threadId, scope, scope === "turn" ? (turnId ?? null) : null, diffStamp],
    queryFn: () => api.gitDiff(threadId, diffScope!),
    enabled: diffScope !== undefined,
    // A new stamp refetches, so a remount (switching back to the thread) can reuse the diff for a
    // while, sparing several `git` runs. Only a while: the stamp's `status` doesn't list inside an
    // untracked directory, so an edit to a file there moves the diff but not the stamp.
    staleTime: diffStamp === null ? 0 : SWITCH_BACK_FRESH_MS,
    retry: false,
  });
  // A single file gets no tree, so the tree takes no width from split view.
  const treeBeside =
    treeShown && width >= TREE_BESIDE_MIN_WIDTH && (query.data?.files?.length ?? 0) > 1;
  const splitFits = width - (treeBeside ? TREE_WIDTH : 0) >= SPLIT_VIEW_MIN_WIDTH;
  const refetch = () => (diffScope === undefined ? Promise.resolve() : query.refetch());
  const request = useLayoutStore((s) => s.panelTargets.diff);
  const consumePanelTarget = useLayoutStore((s) => s.consumePanelTarget);
  const pending = request?.threadId === threadId ? request : undefined;
  const pendingTurn = pending === undefined ? undefined : targetTurnId(pending.target);
  const settled = !query.isPending;

  // A `turn:<id>` target from a transcript chip selects that turn, once per request.
  const [appliedTarget, setAppliedTarget] = useState<number>();
  if (pending !== undefined && pendingTurn !== undefined && pending.id !== appliedTarget) {
    setAppliedTarget(pending.id);
    setScope("turn");
    setPicked(pendingTurn);
  }
  useEffect(() => {
    if (pending !== undefined && pendingTurn !== undefined) consumePanelTarget("diff", pending.id);
  }, [pending, pendingTurn, consumePanelTarget]);

  // Runs after the rows' own effects, so the target row has already expanded and scrolled.
  useEffect(() => {
    if (pending && pendingTurn === undefined && settled) consumePanelTarget("diff", pending.id);
  }, [pending, pendingTurn, settled, consumePanelTarget]);

  return (
    <div
      ref={rootRef}
      data-testid="diff-panel"
      data-layout={layout === "split" && splitFits ? "split" : "unified"}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5 text-xs">
        <div
          role="radiogroup"
          aria-label="Diff scope"
          className="isolate flex gap-1"
          onKeyDown={(event) =>
            radioGroupKeyDown(
              event,
              SCOPES.map((option) => option.kind),
              scope,
              setScope,
            )
          }
        >
          {SCOPES.map((option) => (
            <button
              key={option.kind}
              type="button"
              role="radio"
              aria-checked={scope === option.kind}
              tabIndex={scope === option.kind ? 0 : -1}
              onClick={() => setScope(option.kind)}
              className="relative rounded-(--radius-sm) px-2 py-0.5 text-muted-foreground transition-colors duration-(--dur-fast) outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:text-foreground"
            >
              {scope === option.kind && <SegmentSlab group={scopeSlab} className="bg-muted" />}
              {option.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {scope === "turn" && turnId !== undefined && (
            <select
              aria-label="Turn"
              value={turnId}
              onChange={(event) => setPicked(event.target.value as TurnId)}
              className="max-w-56 min-w-0 truncate rounded-(--radius-sm) border border-border bg-transparent px-1 py-0.5 text-xs"
            >
              {turns.map((turn) => (
                <option key={turn.turnId} value={turn.turnId}>
                  {turn.label}
                </option>
              ))}
            </select>
          )}
          <div
            role="radiogroup"
            aria-label="Diff view"
            className="isolate flex"
            onKeyDown={(event) =>
              radioGroupKeyDown(
                event,
                LAYOUTS.map((option) => option.kind),
                layout,
                setLayout,
              )
            }
          >
            {LAYOUTS.map((option) => {
              const narrow = option.kind === "split" && !splitFits;
              return (
                <button
                  key={option.kind}
                  type="button"
                  role="radio"
                  aria-checked={layout === option.kind}
                  aria-label={option.label}
                  title={narrow ? "Split (needs a wider panel; showing unified)" : option.label}
                  tabIndex={layout === option.kind ? 0 : -1}
                  onClick={() => setLayout(option.kind)}
                  className={cn(
                    "relative rounded-(--radius-sm) p-1 text-muted-foreground transition-colors duration-(--dur-fast) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-checked:text-foreground",
                    narrow && "aria-checked:text-muted-foreground",
                  )}
                >
                  {layout === option.kind && (
                    <SegmentSlab group={layoutSlab} className="bg-muted" />
                  )}
                  <option.icon aria-hidden className="size-3.5" />
                </button>
              );
            })}
          </div>
          <button
            type="button"
            aria-label="File tree"
            aria-pressed={treeShown}
            title={treeShown ? "Hide the file tree" : "Show the file tree"}
            onClick={toggleTree}
            className="rounded-(--radius-sm) p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-muted aria-pressed:text-foreground"
          >
            <ListTree aria-hidden className="size-3.5" />
          </button>
          <RefreshButton
            threadId={threadId}
            label="Refresh diff"
            fetching={query.isFetching}
            refetch={refetch}
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {diffScope === undefined ? (
          <PanelMessage icon={History}>No turns to show yet</PanelMessage>
        ) : (
          <DiffBody
            threadId={threadId}
            scope={scope}
            query={query}
            layout={layout === "split" && splitFits ? "split" : "unified"}
            tree={treeShown ? (treeBeside ? "beside" : "above") : undefined}
            panelRef={rootRef}
            {...(pending && pendingTurn === undefined ? { request: pending } : {})}
          />
        )}
      </div>
    </div>
  );
}

function DiffBody({
  threadId,
  scope,
  query,
  layout,
  tree,
  panelRef,
  request,
}: {
  threadId: ThreadId;
  scope: ScopeKind;
  query: UseQueryResult<Diff>;
  layout: DiffLayout;
  tree: "beside" | "above" | undefined;
  panelRef: RefObject<HTMLElement | null>;
  request?: PanelTarget;
}) {
  const { root, actions } = useDiffFileActions(threadId);
  const review = useDiffReviewState(threadId, query.data);
  const focusPath = request && checkoutRelative(request.target, root);
  const nodes = useMemo(() => buildDiffTree(query.data?.files ?? []), [query.data]);
  const files = useMemo(() => treeOrder(nodes), [nodes]);
  // Every hunk of every file, in the order the list shows them: what n / p step through.
  const hunks = useMemo(
    () =>
      files.flatMap((file, position) =>
        file.binary || file.tooLarge
          ? []
          : Array.from({ length: countHunks(file.patch) }, (_, hunk) => ({
              path: file.path,
              hunk,
              position,
            })),
      ),
    [files],
  );
  const [jump, setJump] = useState<DiffFocus & { index?: number }>();
  const [seenRequest, setSeenRequest] = useState(request?.id);
  const [jumpHunks, setJumpHunks] = useState(hunks);
  // Another scope or a refreshed diff has other hunks: a jump into the old ones means nothing now.
  if (hunks !== jumpHunks) {
    setJumpHunks(hunks);
    setJump(undefined);
  }
  // An agent's newer request wins over the user's last jump.
  if (request?.id !== seenRequest) {
    setSeenRequest(request?.id);
    if (request !== undefined) setJump(undefined);
  }
  const stepHunk = (delta: 1 | -1) => {
    const from = jump?.index;
    // A cursor between hunks (`k - 0.5`) steps to the one either side of it.
    const index =
      from === undefined
        ? delta === 1
          ? 0
          : hunks.length - 1
        : delta === 1
          ? Math.floor(from) + 1
          : Math.ceil(from) - 1;
    const target = hunks[index];
    if (!target) return;
    setJump({ path: target.path, hunk: target.hunk, index, key: --jumpSeq });
  };
  const inPanel = () => panelRef.current?.contains(document.activeElement) === true;
  useShortcut(
    {
      id: "diff.nextHunk",
      keys: "n",
      label: "Next change in the diff",
      group: "Navigation",
      focusScope: inPanel,
      run: () => stepHunk(1),
    },
    hunks.length > 0,
  );
  useShortcut(
    {
      id: "diff.previousHunk",
      keys: "p",
      label: "Previous change in the diff",
      group: "Navigation",
      focusScope: inPanel,
      run: () => stepHunk(-1),
    },
    hunks.length > 0,
  );

  if (query.isPending) return <PanelMessage loading>Loading diff…</PanelMessage>;
  if (query.isError) {
    const problem = folderProblem(query.error);
    if (problem) return <FolderMissing threadId={threadId} problem={problem} />;
    if (Reflect.get(query.error ?? {}, "_tag") === "NotFound") {
      return <PanelMessage>{errorMessage(query.error)}</PanelMessage>;
    }
    return <QueryError error={query.error} feature="The diff" />;
  }
  const diff = query.data;
  if (!diff.repo) return <PanelMessage>Not a git repository</PanelMessage>;
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const fallbackBase = scope === "uncommitted" ? diff.base : undefined;
  const focus: DiffFocus | undefined =
    jump ?? (request && focusPath ? { path: focusPath, key: request.id } : undefined);
  const withTree = tree !== undefined && files.length > 1;

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs text-muted-foreground">
        {diff.branch && (
          <span className="flex min-w-0 items-center gap-1 font-mono">
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{diff.branch}</span>
          </span>
        )}
        {diff.base && fallbackBase === undefined && <span>comparing to {diff.base}</span>}
        {files.length > 0 && (
          <span className="ml-auto font-mono tabular-nums">
            <NumberTicker value={files.length} /> {files.length === 1 ? "file" : "files"} ·{" "}
            <span className="text-success">
              +<NumberTicker value={additions} />
            </span>{" "}
            <span className="text-destructive">
              −<NumberTicker value={deletions} />
            </span>
          </span>
        )}
      </div>
      {fallbackBase && (
        <p data-testid="diff-fallback" className="shrink-0 px-3 pb-2 text-xs text-muted-foreground">
          No uncommitted changes. Showing branch vs {fallbackBase.replace(/^origin\//, "")}
        </p>
      )}
      {diff.note && <p className="shrink-0 px-3 pb-2 text-xs text-warning">{diff.note}</p>}
      {files.length === 0 ? (
        <PanelMessage icon={GitCompareArrows}>No changes</PanelMessage>
      ) : (
        <div
          className={cn(
            "flex min-h-0 flex-1 border-t border-border",
            tree === "beside" ? "flex-row" : "flex-col",
          )}
        >
          {withTree && (
            <DiffTree
              nodes={nodes}
              selected={focus?.path}
              onJump={(path) => {
                // The cursor sits just before the file's first hunk, or where it would be if the
                // file has none, so n and p go on to the hunks either side.
                const position = files.findIndex((file) => file.path === path);
                const next = hunks.findIndex((h) => h.position >= position);
                setJump({ path, key: --jumpSeq, index: (next === -1 ? hunks.length : next) - 0.5 });
              }}
              className={cn(
                "shrink-0 overflow-y-auto",
                tree === "beside"
                  ? "w-52 border-r border-border"
                  : "max-h-40 border-b border-border",
              )}
            />
          )}
          <div data-testid="diff-files" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <DiffReviewContext value={review}>
              <DiffFileList files={files} layout={layout} {...actions} focus={focus} />
            </DiffReviewContext>
          </div>
        </div>
      )}
    </>
  );
}
