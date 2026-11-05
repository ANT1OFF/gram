import { Menu } from "@base-ui/react/menu";
import {
  DIFF_TOO_LARGE_NOTE,
  type Diff,
  type DiffScope,
  type ThreadId,
  type TurnId,
} from "@gram/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Columns2,
  GitBranch,
  History,
  ListTree,
  Pilcrow,
  Rows2,
  WrapText,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { useApi } from "@/api/context";
import { errorMessage, folderProblem } from "@/api/errors";
import { Hint } from "@/components/hint";
import { QueryError } from "@/components/not-available";
import { useShortcut } from "@/keyboard/registry";
import { radioGroupKeyDown } from "@/lib/list-keys";
import { MENU_ITEM, MENU_LABEL, MENU_POPUP } from "@/lib/selection";
import { useStableSelector } from "@/lib/use-stable";
import { cn } from "@/lib/utils";
import { NumberTicker, SegmentSlab } from "@/motion";
import { SEGMENT_SLAB, SEGMENT_TRACK } from "@/settings/fields";
import { useThreadFeed } from "@/stores/feeds";
import { useLayoutStore, type DiffLayout, type PanelTarget } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { DiffChunkSourceContext } from "./diff-chunks";
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
/**
 * The panel's narrowest width for the file tree, beside the files. Narrower, the file list is the
 * only list: the tree above it would name the same files a second time.
 */
const TREE_BESIDE_MIN_WIDTH = 720;
/**
 * The most files a patch can touch and still open with its tree folded away: so few are read top
 * to bottom, and the tree would only name them again. "Files (n)" opens it.
 */
const SMALL_PATCH_FILES = 3;
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
  const layout = useLayoutStore((s) => s.diffLayout);
  const setLayout = useLayoutStore((s) => s.setDiffLayout);
  const treeShown = useLayoutStore((s) => s.diffTreeShown);
  const toggleTree = useLayoutStore((s) => s.toggleDiffTree);
  const wrap = useLayoutStore((s) => s.diffWrap);
  const toggleWrap = useLayoutStore((s) => s.toggleDiffWrap);
  const ignoreWhitespace = useLayoutStore((s) => s.diffIgnoreWhitespace);
  const toggleIgnoreWhitespace = useLayoutStore((s) => s.toggleDiffIgnoreWhitespace);
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
  const diffKey = [
    "git.diff",
    threadId,
    scope,
    scope === "turn" ? (turnId ?? null) : null,
    diffStamp,
  ] as const;
  const query = useQuery({
    queryKey: [...diffKey, ignoreWhitespace],
    // Whitespace switched on or off, the diff it was stays until the new one comes, so the files
    // opened in it stay open.
    placeholderData: (previous, previousQuery) =>
      diffKey.every((part, at) => previousQuery?.queryKey[at] === part) ? previous : undefined,
    queryFn: () =>
      ignoreWhitespace
        ? api.gitDiff(threadId, diffScope!, { ignoreWhitespace })
        : api.gitDiff(threadId, diffScope!),
    enabled: diffScope !== undefined,
    // A new stamp refetches, so a remount (switching back to the thread) can reuse the diff for a
    // while, sparing several `git` runs. Only a while: the stamp's `status` doesn't list inside an
    // untracked directory, so an edit to a file there moves the diff but not the stamp.
    staleTime: diffStamp === null ? 0 : SWITCH_BACK_FRESH_MS,
    retry: false,
  });
  const treeFits = width >= TREE_BESIDE_MIN_WIDTH;
  const fileCount = query.data?.files?.length ?? 0;
  // How much the scope holds, beside it: shown once there is a diff with something in it.
  const diffFiles = diffScope === undefined ? undefined : query.data?.files;
  const summary =
    diffFiles === undefined || diffFiles.length === 0
      ? undefined
      : {
          files: diffFiles.length,
          additions: diffFiles.reduce((sum, f) => sum + f.additions, 0),
          deletions: diffFiles.reduce((sum, f) => sum + f.deletions, 0),
        };
  // A small patch's tree starts folded whatever the stored choice, which is a larger patch's.
  const smallPatch = fileCount <= SMALL_PATCH_FILES;
  const [smallTreeOpen, setSmallTreeOpen] = useState(false);
  const treeOpen = smallPatch ? smallTreeOpen : treeShown;
  // A single file gets no tree, so the tree takes no width from split view.
  const treeBeside = treeOpen && treeFits && fileCount > 1;
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
      {/* What is shown first: the scope, on a track with its pick on the selected slab, then how
          much it holds. The display choices fold into one labelled View menu beside Refresh. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2 py-1.5 text-meta">
        <div
          role="radiogroup"
          aria-label="Diff scope"
          className={SEGMENT_TRACK}
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
              className="relative flex h-6 items-center rounded-md px-2 text-body text-muted-foreground transition-colors duration-(--dur-fast) outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-checked:text-foreground"
            >
              {scope === option.kind && <SegmentSlab group={scopeSlab} className={SEGMENT_SLAB} />}
              {option.label}
            </button>
          ))}
        </div>
        {summary !== undefined && (
          <span
            data-testid="diff-summary"
            data-files={summary.files}
            className="flex items-baseline gap-1.5 text-body whitespace-nowrap tabular-nums"
          >
            <span className="font-medium">
              <NumberTicker value={summary.files} /> {summary.files === 1 ? "file" : "files"}
            </span>
            <span className="font-mono text-meta text-success">
              +<NumberTicker value={summary.additions} />
            </span>
            <span className="font-mono text-meta text-destructive">
              −<NumberTicker value={summary.deletions} />
            </span>
          </span>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {scope === "turn" && turnId !== undefined && (
            <select
              aria-label="Turn"
              value={turnId}
              onChange={(event) => setPicked(event.target.value as TurnId)}
              className="max-w-56 min-w-0 truncate rounded-(--radius-sm) border border-border bg-transparent px-1 py-0.5 text-meta"
            >
              {turns.map((turn) => (
                <option key={turn.turnId} value={turn.turnId}>
                  {turn.label}
                </option>
              ))}
            </select>
          )}
          <DiffViewMenu
            layout={layout}
            onLayout={setLayout}
            splitFits={splitFits}
            wrap={wrap}
            onWrap={toggleWrap}
            ignoreWhitespace={ignoreWhitespace}
            onIgnoreWhitespace={toggleIgnoreWhitespace}
            tree={
              treeFits && fileCount > 1
                ? {
                    open: treeOpen,
                    toggle: smallPatch ? () => setSmallTreeOpen((open) => !open) : toggleTree,
                  }
                : undefined
            }
          />
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
            diffScope={diffScope}
            query={query}
            layout={layout === "split" && splitFits ? "split" : "unified"}
            wrap={wrap}
            ignoreWhitespace={ignoreWhitespace}
            tree={treeBeside ? "beside" : undefined}
            panelRef={rootRef}
            {...(pending && pendingTurn === undefined ? { request: pending } : {})}
          />
        )}
      </div>
    </div>
  );
}

const VIEW_POPUP = cn(MENU_POPUP, "min-w-56");

/**
 * The diff's display choices under one labelled menu: unified or split, then wrap, whitespace and
 * the file tree as checks. Each choice is remembered. Split says when the panel is too narrow for
 * it (it shows unified until there is room), and Wrap lines says when split view holds it on.
 */
function DiffViewMenu({
  layout,
  onLayout,
  splitFits,
  wrap,
  onWrap,
  ignoreWhitespace,
  onIgnoreWhitespace,
  tree,
}: {
  layout: DiffLayout;
  onLayout: (layout: DiffLayout) => void;
  splitFits: boolean;
  wrap: boolean;
  onWrap: () => void;
  ignoreWhitespace: boolean;
  onIgnoreWhitespace: () => void;
  /** The file tree's choice, while the panel has room for it beside more than one file. */
  tree: { open: boolean; toggle: () => void } | undefined;
}) {
  const shown = layout === "split" && splitFits ? "split" : "unified";
  // Each side of a split is half as wide, so its lines always wrap.
  const wrapFixed = shown === "split";
  const current = [
    shown === "split" ? "Split" : "Unified",
    ...(wrap || wrapFixed ? ["wrapped"] : []),
    ...(ignoreWhitespace ? ["ignoring whitespace"] : []),
  ].join(", ");
  return (
    <Menu.Root>
      <Hint
        label={`View: ${current}`}
        side="bottom"
        render={
          <Menu.Trigger
            data-testid="diff-view-menu"
            className="flex h-7 shrink-0 items-center gap-1 rounded-(--radius-sm) px-1.5 text-meta text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted data-popup-open:text-foreground"
          />
        }
      >
        View
        <ChevronDown aria-hidden className="size-3.5" />
      </Hint>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup data-surface="overlay" data-testid="diff-view-popup" className={VIEW_POPUP}>
            <Menu.Group>
              <Menu.GroupLabel className={MENU_LABEL}>Layout</Menu.GroupLabel>
              <Menu.RadioGroup value={layout} onValueChange={(next: DiffLayout) => onLayout(next)}>
                {LAYOUTS.map((option) => {
                  const narrow = option.kind === "split" && !splitFits;
                  return (
                    <Menu.RadioItem
                      key={option.kind}
                      value={option.kind}
                      closeOnClick={false}
                      aria-label={option.label}
                      title={narrow ? "Split (needs a wider panel; showing unified)" : undefined}
                      className={MENU_ITEM}
                    >
                      <MenuCheck>
                        <Menu.RadioItemIndicator>
                          <Check aria-hidden />
                        </Menu.RadioItemIndicator>
                      </MenuCheck>
                      <option.icon aria-hidden className="text-muted-foreground" />
                      {option.label}
                      {narrow && (
                        <span className="ml-auto text-caption text-muted-foreground">
                          Needs a wider panel
                        </span>
                      )}
                    </Menu.RadioItem>
                  );
                })}
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator className="mx-1 my-1 h-px bg-border" />
            <ViewCheck
              label="Wrap lines"
              icon={WrapText}
              checked={wrapFixed || wrap}
              onToggle={onWrap}
              fixed={wrapFixed ? "Always in split view" : undefined}
            />
            <ViewCheck
              label="Ignore whitespace"
              icon={Pilcrow}
              checked={ignoreWhitespace}
              onToggle={onIgnoreWhitespace}
            />
            {tree !== undefined && (
              <ViewCheck
                label="File tree"
                icon={ListTree}
                checked={tree.open}
                onToggle={tree.toggle}
                testId="diff-tree-toggle"
              />
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The check column a menu's pick shows in, kept as wide when nothing is picked. */
function MenuCheck({ children }: { children: ReactNode }) {
  return <span className="flex size-3.5 items-center justify-center">{children}</span>;
}

/** A remembered on/off choice in the View menu. `fixed` says why it is on whatever the choice. */
function ViewCheck({
  label,
  icon: Icon,
  checked,
  onToggle,
  fixed,
  testId,
}: {
  label: string;
  icon: LucideIcon;
  checked: boolean;
  onToggle: () => void;
  fixed?: string | undefined;
  testId?: string;
}) {
  return (
    <Menu.CheckboxItem
      checked={checked}
      onCheckedChange={() => onToggle()}
      disabled={fixed !== undefined}
      closeOnClick={false}
      aria-label={label}
      data-testid={testId}
      className={MENU_ITEM}
    >
      <MenuCheck>
        <Menu.CheckboxItemIndicator>
          <Check aria-hidden />
        </Menu.CheckboxItemIndicator>
      </MenuCheck>
      <Icon aria-hidden className="text-muted-foreground" />
      {label}
      {fixed !== undefined && (
        <span className="ml-auto text-caption text-muted-foreground">{fixed}</span>
      )}
    </Menu.CheckboxItem>
  );
}

function DiffBody({
  threadId,
  scope,
  diffScope,
  query,
  layout,
  wrap,
  ignoreWhitespace,
  tree,
  panelRef,
  request,
}: {
  threadId: ThreadId;
  scope: ScopeKind;
  /** What `query` asked for, and what a file too large for it is asked for again in chunks. */
  diffScope: DiffScope | undefined;
  query: UseQueryResult<Diff>;
  layout: DiffLayout;
  wrap: boolean;
  ignoreWhitespace: boolean;
  tree: "beside" | undefined;
  panelRef: RefObject<HTMLElement | null>;
  request?: PanelTarget;
}) {
  const { root, actions } = useDiffFileActions(threadId);
  const review = useDiffReviewState(threadId, query.data);
  // Its agent's session is still opening: no change could have been made yet.
  const starting = useThreadsStore((s) => s.byId[threadId]?.status === "starting");
  const focusPath = request && checkoutRelative(request.target, root);
  // Its consumers re-render with the list anyway: the query keys, not this object, decide reuse.
  const chunkSource =
    diffScope === undefined ? undefined : { threadId, scope: diffScope, ignoreWhitespace };
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
  const fallbackBase = scope === "uncommitted" ? diff.base : undefined;
  // Nothing to show is one line, not a heading, a notice and an empty state.
  if (files.length === 0) {
    const base = (fallbackBase ?? diff.base)?.replace(/^origin\//, "");
    if (starting) {
      return (
        <p data-testid="diff-empty" className="px-3 py-2 text-meta text-muted-foreground">
          No changes yet: the agent is starting.
        </p>
      );
    }
    // Changes too large to list are not "no changes".
    if (diff.note === DIFF_TOO_LARGE_NOTE) {
      return (
        <p data-testid="diff-empty" className="px-3 py-2 text-meta text-warning">
          These changes are too large to list here. Read them in your editor or a terminal with git
          diff.
        </p>
      );
    }
    return (
      <>
        <p data-testid="diff-empty" className="px-3 py-2 text-meta text-muted-foreground">
          No changes{diff.branch ? ` on ${diff.branch}` : ""}
          {base && (scope !== "uncommitted" || fallbackBase) ? ` against ${base}` : ""}
          {ignoreWhitespace ? ", ignoring whitespace" : ""}
        </p>
        {diff.note && <p className="px-3 pb-2 text-meta text-warning">{diff.note}</p>}
      </>
    );
  }
  const focus: DiffFocus | undefined =
    jump ?? (request && focusPath ? { path: focusPath, key: request.id } : undefined);
  const withTree = tree !== undefined && files.length > 1;

  return (
    <>
      {/* Where the diff stands; how much it holds is beside its scope, above. */}
      {(diff.branch || (diff.base && fallbackBase === undefined)) && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-meta text-muted-foreground">
          {diff.branch && (
            <span className="flex min-w-0 items-center gap-1 font-mono">
              <GitBranch aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{diff.branch}</span>
            </span>
          )}
          {diff.base && fallbackBase === undefined && <span>comparing to {diff.base}</span>}
        </div>
      )}
      {fallbackBase && (
        <p
          data-testid="diff-fallback"
          className="shrink-0 px-3 pb-2 text-meta text-muted-foreground"
        >
          No uncommitted changes. Showing branch vs {fallbackBase.replace(/^origin\//, "")}
        </p>
      )}
      {diff.note && <p className="shrink-0 px-3 pb-2 text-meta text-warning">{diff.note}</p>}
      <div
        className={cn(
          "flex min-h-0 flex-1 border-t border-border",
          withTree ? "flex-row" : "flex-col",
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
            className="w-52 shrink-0 overflow-y-auto border-r border-border"
          />
        )}
        <div data-testid="diff-files" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <DiffReviewContext value={review}>
            <DiffChunkSourceContext value={chunkSource}>
              <DiffFileList files={files} layout={layout} wrap={wrap} {...actions} focus={focus} />
            </DiffChunkSourceContext>
          </DiffReviewContext>
        </div>
      </div>
    </>
  );
}
