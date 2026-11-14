import {
  DIFF_TOO_LARGE_NOTE,
  type Diff,
  type DiffScope,
  type ThreadId,
  type TurnId,
} from "@gram/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Menu } from "@base-ui/react/menu";
import {
  CheckIcon,
  ChevronDown,
  GitBranch,
  History,
  ListTree,
  type LucideIcon,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { useApi } from "@/api/context";
import { errorMessage, folderProblem } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button, buttonVariants } from "@/components/ui/button";
import { QueryError } from "@/components/not-available";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useShortcut } from "@/keyboard/registry";
import { radioGroupKeyDown } from "@/lib/list-keys";
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
  { kind: "unified", label: "Unified" },
  { kind: "split", label: "Split" },
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
 * changes, or on Refresh. Until the user picks a scope it follows the tree: Uncommitted while there
 * are uncommitted changes, Branch, selected and noted, once a clean tree's branch is ahead of its
 * base (a commit that empties the tree included). Uncommitted picked on a clean tree says so and
 * offers the branch. An agent's diff target is focused once the diff has loaded; a `turn:<id>` target
 * selects that turn instead. Unified or split and the file tree are the user's choice, remembered;
 * split falls back to unified while the panel is too narrow for it.
 */
export function DiffPanel({
  threadId,
  prLink = false,
}: {
  threadId: ThreadId;
  /** The PR tab sits beside this diff, so an empty diff can offer the thread's PR. */
  prLink?: boolean;
}) {
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
  // The user's pick of scope; until there is one, the scope follows the tree (`autoScope`).
  const [chosen, setScope] = useState<ScopeKind>();
  const branchAhead = useThreadsStore((s) => {
    const git = s.byId[threadId]?.git;
    return git !== undefined && git.changedFiles === 0 && git.aheadBase > 0;
  });
  // The stamp at which an Uncommitted diff came back as the clean tree's branch fallback: the
  // server's base can say so where the published state hasn't yet.
  const [fellBackAt, setFellBackAt] = useState<string | null>();
  const autoScope: ScopeKind =
    branchAhead || (fellBackAt !== undefined && fellBackAt === diffStamp)
      ? "branch"
      : "uncommitted";
  const scope = chosen ?? autoScope;
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
    // opened in it stay open; so does a clean tree's fallback to the branch while Branch loads.
    placeholderData: (previous, previousQuery) =>
      diffKey.every(
        (part, at) =>
          previousQuery?.queryKey[at] === part ||
          (at === 2 &&
            part === "branch" &&
            previousQuery?.queryKey[at] === "uncommitted" &&
            previous?.base !== undefined),
      )
        ? previous
        : undefined,
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
  // Uncommitted, unpicked, came back as the branch: select Branch rather than leave Uncommitted
  // selected over the branch's files.
  if (
    chosen === undefined &&
    scope === "uncommitted" &&
    query.data?.base !== undefined &&
    !query.isPlaceholderData &&
    fellBackAt !== diffStamp
  ) {
    setFellBackAt(diffStamp);
  }
  const autoBranch = chosen === undefined && scope === "branch";
  const treeFits = width >= TREE_BESIDE_MIN_WIDTH;
  const fileCount = query.data?.files?.length ?? 0;
  // How much the selected scope holds, beside it: shown once there is a diff with something in it.
  // Uncommitted on a clean tree comes back as the branch, which the body says is nothing
  // uncommitted: the branch's totals beside that would contradict it, so it shows none.
  const diffFiles =
    diffScope === undefined || branchInstead(scope, query.data) ? undefined : query.data?.files;
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
  // Where the diff stands, in the toolbar rather than a row of its own under it.
  const branch = diffScope === undefined ? undefined : query.data?.branch;
  const compared = scope === "uncommitted" ? undefined : query.data?.base?.replace(/^origin\//, "");
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
      {/* The review's one toolbar: the scope, on a track with its pick on the selected slab, how
          much it holds and on which branch, then the turn, the display choices and Refresh. In a
          narrow panel it is two rows that stay put: the controls, then what the diff holds. Left
          to wrap where it would, the display choices fell to a row of their own. */}
      <div className="@container/diffbar shrink-0 border-b border-border px-2 py-1.5 text-meta">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
                {scope === option.kind && (
                  <SegmentSlab group={scopeSlab} className={SEGMENT_SLAB} />
                )}
                {option.label}
              </button>
            ))}
          </div>
          <div
            data-testid="diff-holds"
            className="flex min-w-0 items-center gap-x-2 empty:hidden @max-2xl/diffbar:order-last @max-2xl/diffbar:basis-full @2xl/diffbar:flex-1"
          >
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
            {branch !== undefined && (
              <Hint
                label={compared === undefined ? branch : `${branch}, comparing to ${compared}`}
                side="bottom"
                render={
                  <span
                    data-testid="diff-branch"
                    className="flex min-w-0 items-center gap-1 font-mono text-meta text-muted-foreground"
                  />
                }
              >
                <GitBranch aria-hidden className="size-icon-chip shrink-0" />
                <span className="truncate">{branch}</span>
                {compared !== undefined && (
                  <span className="shrink-0 font-sans">vs {compared}</span>
                )}
              </Hint>
            )}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {scope === "turn" && turnId !== undefined && (
              // The app's dropdown, as every other picker in the panel; its value is the turn's prompt.
              <Select
                value={turnId}
                onValueChange={(value) => {
                  if (value !== null) setPicked(value as TurnId);
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Turn"
                  title={turns.find((turn) => turn.turnId === turnId)?.label}
                  className="max-w-56 min-w-0 text-meta"
                >
                  <SelectValue>
                    {turns.find((turn) => turn.turnId === turnId)?.label ?? "Turn"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  {turns.map((turn) => (
                    <SelectItem key={turn.turnId} value={turn.turnId} className="text-meta">
                      {turn.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <DiffViewControls
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
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {diffScope === undefined ? (
          <PanelMessage icon={History}>No turns to show yet</PanelMessage>
        ) : (
          <DiffBody
            threadId={threadId}
            scope={scope}
            autoBranch={autoBranch}
            onScope={setScope}
            prLink={prLink}
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

/** A view toggle: a 28 px glyph button on a fill while on, named with its state on hover. */
const VIEW_TOGGLE =
  "flex size-7 shrink-0 items-center justify-center rounded-(--radius-sm) text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:text-foreground";

const VIEW_MENU_POPUP =
  "z-50 min-w-56 origin-(--transform-origin) rounded-md border border-edge bg-popover p-1 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const VIEW_MENU_ITEM =
  "flex cursor-default items-start gap-2 rounded-sm px-2 py-1.5 text-body outline-none select-none data-[highlighted]:row-cursor data-[disabled]:text-muted-foreground [&_svg]:size-icon-row [&_svg]:shrink-0";

/** A menu item's check column, so the items' words start on one edge. */
function MenuCheck({ children }: { children: ReactNode }) {
  return <span className="flex h-lh w-4 shrink-0 items-center justify-center">{children}</span>;
}

/**
 * The diff's display choices, in the review's toolbar: the file tree, the one used often, as a
 * toggle that shows a fill while on, then one "View" menu holding unified or split, Wrap lines and
 * Hide whitespace changes. Each is remembered. Split says in the menu when the panel is too narrow
 * for it (it shows unified until there is room), and Wrap lines when split view holds it on.
 */
function DiffViewControls({
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
  return (
    <div data-testid="diff-view" className="flex shrink-0 items-center gap-1">
      {tree !== undefined && (
        <ViewToggle
          label="File tree"
          icon={ListTree}
          pressed={tree.open}
          onToggle={tree.toggle}
          testId="diff-tree-toggle"
        />
      )}
      <Menu.Root>
        <Menu.Trigger
          data-testid="diff-view-menu"
          aria-label="View options"
          title="View options"
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "px-2 data-popup-open:bg-accent data-popup-open:text-foreground",
          )}
        >
          {/* The word where the toolbar has room for it beside the scope; the glyph alone below. */}
          <SlidersHorizontal aria-hidden className="size-icon-row @[21rem]/diffbar:hidden" />
          <span className="@max-[21rem]/diffbar:hidden">View</span>
          <ChevronDown
            aria-hidden
            className="size-icon-chip text-muted-foreground @max-[21rem]/diffbar:hidden"
          />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
            <Menu.Popup
              data-testid="diff-view-options"
              data-surface="overlay"
              className={VIEW_MENU_POPUP}
            >
              <Menu.RadioGroup
                aria-label="Diff layout"
                value={layout}
                onValueChange={(next: DiffLayout) => onLayout(next)}
              >
                {LAYOUTS.map((option) => (
                  <Menu.RadioItem
                    key={option.kind}
                    value={option.kind}
                    data-layout={option.kind}
                    className={VIEW_MENU_ITEM}
                  >
                    <MenuCheck>
                      <Menu.RadioItemIndicator>
                        <CheckIcon aria-hidden />
                      </Menu.RadioItemIndicator>
                    </MenuCheck>
                    <span className="flex min-w-0 flex-col">
                      {option.label}
                      {option.kind === "split" && !splitFits && (
                        <span className="text-meta text-muted-foreground">
                          Needs a wider panel; showing unified
                        </span>
                      )}
                    </span>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
              <Menu.Separator className="mx-2 my-1 h-px bg-border" />
              <Menu.CheckboxItem
                checked={wrapFixed || wrap}
                disabled={wrapFixed}
                onCheckedChange={onWrap}
                className={VIEW_MENU_ITEM}
              >
                <MenuCheck>
                  <Menu.CheckboxItemIndicator>
                    <CheckIcon aria-hidden />
                  </Menu.CheckboxItemIndicator>
                </MenuCheck>
                <span className="flex min-w-0 flex-col">
                  Wrap lines
                  {wrapFixed && (
                    <span className="text-meta text-muted-foreground">Always on in split view</span>
                  )}
                </span>
              </Menu.CheckboxItem>
              <Menu.CheckboxItem
                checked={ignoreWhitespace}
                onCheckedChange={onIgnoreWhitespace}
                className={VIEW_MENU_ITEM}
              >
                <MenuCheck>
                  <Menu.CheckboxItemIndicator>
                    <CheckIcon aria-hidden />
                  </Menu.CheckboxItemIndicator>
                </MenuCheck>
                Hide whitespace changes
              </Menu.CheckboxItem>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

/** A remembered on/off view choice, named with its state on hover. */
function ViewToggle({
  label,
  icon: Icon,
  pressed,
  onToggle,
  testId,
}: {
  label: string;
  icon: LucideIcon;
  pressed: boolean;
  onToggle: () => void;
  testId?: string;
}) {
  return (
    <Hint
      label={`${label}: ${pressed ? "on" : "off"}`}
      side="bottom"
      render={
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          data-testid={testId}
          onClick={onToggle}
          className={VIEW_TOGGLE}
        />
      }
    >
      <Icon aria-hidden className="size-icon-row" />
    </Hint>
  );
}

function DiffBody({
  threadId,
  scope,
  autoBranch,
  onScope,
  prLink,
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
  /** Branch is selected because the tree is clean, not by the user's pick. */
  autoBranch: boolean;
  onScope: (scope: ScopeKind) => void;
  prLink: boolean;
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
  // An empty diff of a thread with a PR offers the PR's files, where the PR tab is beside it.
  const prNumber = useThreadsStore((s) => s.byId[threadId]?.git?.pr?.number);
  const requestPanel = useLayoutStore((s) => s.requestPanel);
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
  // Uncommitted, picked on a clean tree: the server answers with the branch, which is Branch's to
  // show. Here it is nothing uncommitted, and the branch one click away.
  const branchBase = branchInstead(scope, diff) ? diff.base?.replace(/^origin\//, "") : undefined;
  if (branchBase !== undefined) {
    return (
      <EmptyDiff action={{ label: `Show branch vs ${branchBase}`, run: () => onScope("branch") }}>
        No uncommitted changes{diff.branch ? ` on ${diff.branch}` : ""}
      </EmptyDiff>
    );
  }
  // Nothing to show is one line, not a heading, a notice and an empty state.
  if (files.length === 0) {
    const base = diff.base?.replace(/^origin\//, "");
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
        <p data-testid="diff-empty" className="px-3 py-2 text-meta text-muted-foreground">
          These changes are too large to list here. Read them in your editor or a terminal with git
          diff.
        </p>
      );
    }
    const prFiles =
      prNumber !== undefined && prLink && scope !== "turn"
        ? {
            label: `Open PR #${prNumber}`,
            run: () => requestPanel({ threadId, panel: "pr" }, threadId),
          }
        : undefined;
    return (
      <EmptyDiff note={diff.note} action={prFiles}>
        No {scope === "uncommitted" ? "uncommitted " : ""}changes
        {diff.branch ? ` on ${diff.branch}` : ""}
        {base && scope !== "uncommitted" ? ` against ${base}` : ""}
        {ignoreWhitespace ? ", ignoring whitespace" : ""}
      </EmptyDiff>
    );
  }
  const focus: DiffFocus | undefined =
    jump ?? (request && focusPath ? { path: focusPath, key: request.id } : undefined);
  const withTree = tree !== undefined && files.length > 1;

  return (
    <>
      {autoBranch && (
        <p
          data-testid="diff-fallback"
          className="shrink-0 px-3 pb-2 text-meta text-muted-foreground"
        >
          No uncommitted changes. Showing branch vs{" "}
          {(diff.base ?? "its base").replace(/^origin\//, "")}
        </p>
      )}
      {diff.note && (
        <p className="shrink-0 px-3 pb-2 text-meta text-muted-foreground">{diff.note}</p>
      )}
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

/**
 * Whether the diff is the branch the server answered Uncommitted with, the tree being clean: it
 * holds nothing of the selected scope, so neither the body nor the totals show its files.
 */
const branchInstead = (scope: ScopeKind, diff: Pick<Diff, "base"> | undefined): boolean =>
  scope === "uncommitted" && diff?.base !== undefined;

/** An empty scope in one line, with any note, and at most one way on to something to read. */
function EmptyDiff({
  note,
  action,
  children,
}: {
  note?: string | undefined;
  action?: { label: string; run: () => void } | undefined;
  children: ReactNode;
}) {
  return (
    <div className="px-3 py-2">
      <p data-testid="diff-empty" className="text-meta text-muted-foreground">
        {children}
      </p>
      {note && <p className="pt-1 text-meta text-muted-foreground">{note}</p>}
      {action && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="diff-empty-action"
          className="mt-2"
          onClick={action.run}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
