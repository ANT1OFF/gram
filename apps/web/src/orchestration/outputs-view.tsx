import {
  checkoutRoots,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceOutput,
} from "@gram/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  File,
  FileText,
  Film,
  FolderOpen,
  Images,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import { QueryError } from "@/components/not-available";
import { Button } from "@/components/ui/button";
import { revealLabel, useRevealInFileManager } from "@/editor/use-open-in-editor";
import { radioGroupKeyDown } from "@/lib/list-keys";
import { useNow } from "@/lib/use-now";
import { SegmentSlab } from "@/motion";
import { imageDataUrl, useAttachmentImage, useCheckoutImage } from "@/panels/files/image-preview";
import { PanelMessage } from "@/panels/panel-message";
import { showFileAt } from "@/panels/files/files-store";
import { useFeature } from "@/settings/use-diagnostics";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { Dialog } from "@/thread/dialog-shell";
import { formatBytes } from "@/thread/orchestration-model";

import {
  groupOutputs,
  OUTPUT_FILTER_LABELS,
  OUTPUT_FILTERS,
  OUTPUT_GROUPING_LABELS,
  OUTPUT_GROUPINGS,
  outputName,
  outputTime,
  insideRoots,
  outputOpenable,
  outputViewer,
  type OutputFilter,
  type OutputGrouping,
} from "./outputs-model";
import { useWorkspacesQuery } from "./use-orchestration";

const KIND_ICONS: Record<WorkspaceOutput["kind"], LucideIcon> = {
  screenshot: Images,
  recording: Film,
  image: Images,
  document: FileText,
  other: File,
};

/** A row of one-word choices, one picked, as the view switcher draws them. */
function Segments<T extends string>({
  label,
  values,
  labels,
  value,
  onChange,
}: {
  label: string;
  values: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (value: T) => void;
}) {
  const slab = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="isolate flex items-center gap-0.5"
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) =>
        radioGroupKeyDown(event, values, value, onChange)
      }
    >
      {values.map((each) => (
        <button
          key={each}
          type="button"
          role="radio"
          aria-checked={each === value}
          tabIndex={each === value ? 0 : -1}
          data-value={each}
          onClick={() => onChange(each)}
          className="relative flex h-6 items-center rounded-(--radius-sm) px-2 text-[13px] text-muted-foreground outline-none transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-checked:text-foreground"
        >
          {each === value && <SegmentSlab group={slab} className="bg-muted" />}
          {labels[each]}
        </button>
      ))}
    </div>
  );
}

/** True once `anchor` has come near the viewport, so a thumbnail reads its bytes only then. */
function useSeen(anchor: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = anchor.current;
    if (seen || element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor, seen]);
  return seen;
}

/** The entry's picture as a data URL, read through its thread's own scoped path. */
function useOutputImage(output: WorkspaceOutput, enabled: boolean): string | undefined {
  const viewer = outputViewer(output);
  const attachment = useAttachmentImage(
    output.threadId,
    output.path,
    enabled && viewer === "attachment",
  );
  const checkout = useCheckoutImage(output.threadId, output.path, enabled && viewer === "checkout");
  return imageDataUrl(viewer === "attachment" ? attachment.data : checkout.data);
}

function Thumb({ output, seen }: { output: WorkspaceOutput; seen: boolean }) {
  const src = useOutputImage(output, seen && outputViewer(output) !== "panel");
  const Icon = KIND_ICONS[output.kind];
  return src === undefined ? (
    <span className="flex size-full items-center justify-center text-muted-foreground">
      <Icon aria-hidden strokeWidth={1.5} className="size-7 opacity-70" />
    </span>
  ) : (
    <img src={src} alt="" className="size-full object-cover object-top" draggable={false} />
  );
}

/** The folders of `threadId` as the sidebar knows them; none for a thread it doesn't have. */
const rootsOf = (threadId: ThreadId) => {
  const thread = useThreadsStore.getState().byId[threadId]?.thread;
  return thread === undefined ? [] : checkoutRoots(thread);
};

/** Where the thread is, and the file in its Files panel when it opens there. */
function useOutputActions() {
  const navigate = useNavigate();
  const reveal = useRevealInFileManager();
  const openThread = (threadId: ThreadId) => {
    useLayoutStore.getState().openThread(threadId);
    void navigate({ to: "/t/$threadId", params: { threadId } });
  };
  return {
    openThread,
    inPanel: (output: WorkspaceOutput) => {
      openThread(output.threadId);
      showFileAt(output.threadId, rootsOf(output.threadId), output.path);
    },
    // Scoped to the thread when it's in its folders; a stored image is shown where Gram keeps it.
    reveal: (output: WorkspaceOutput) => {
      const inRoots = insideRoots(output.path, rootsOf(output.threadId));
      void reveal(output.path, inRoots ? { threadId: output.threadId } : {});
    },
  };
}

function Tile({
  output,
  onOpen,
  canReveal,
}: {
  output: WorkspaceOutput;
  onOpen: (output: WorkspaceOutput) => void;
  canReveal: boolean;
}) {
  const anchor = useRef<HTMLLIElement>(null);
  const seen = useSeen(anchor);
  const actions = useOutputActions();
  const name = outputName(output.path);
  const openable = outputOpenable(output, rootsOf(output.threadId));
  const frame =
    "block aspect-[16/10] overflow-hidden rounded-(--radius-md) border border-border bg-muted/50";
  return (
    <li
      ref={anchor}
      data-testid="output-tile"
      data-kind={output.kind}
      data-thread-id={output.threadId}
      data-openable={openable}
      className="group/tile relative flex min-w-0 flex-col gap-1.5"
    >
      {openable ? (
        <Hint
          label={`${name}\n${output.threadTitle}`}
          render={
            <button
              type="button"
              aria-label={`Open ${name}`}
              onClick={() => onOpen(output)}
              className={`${frame} outline-none transition-[border-color] duration-(--dur-fast) hover:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring`}
            />
          }
        >
          <Thumb output={output} seen={seen} />
        </Hint>
      ) : (
        <div className={frame} title={`${name}\n${output.threadTitle}`}>
          <Thumb output={output} seen={seen} />
        </div>
      )}
      <div className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{outputTime(output)}</span>
      </div>
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity duration-(--dur-fast) group-focus-within/tile:opacity-100 group-hover/tile:opacity-100">
        <Button
          size="icon-xs"
          variant="secondary"
          aria-label="Open thread"
          title="Open thread"
          data-testid="output-open-thread"
          onClick={() => actions.openThread(output.threadId)}
        >
          <MessageSquare />
        </Button>
        {canReveal && (
          <Button
            size="icon-xs"
            variant="secondary"
            aria-label={revealLabel()}
            title={revealLabel()}
            data-testid="output-reveal"
            onClick={() => actions.reveal(output)}
          >
            <FolderOpen />
          </Button>
        )}
      </div>
    </li>
  );
}

/** A picture at full size, with the thread that made it one click away. */
function Viewer({
  output,
  canReveal,
  onClose,
}: {
  output: WorkspaceOutput;
  canReveal: boolean;
  onClose: () => void;
}) {
  const src = useOutputImage(output, true);
  const actions = useOutputActions();
  const name = outputName(output.path);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid="output-viewer"
          data-surface="overlay"
          className="fixed inset-6 z-50 flex flex-col gap-3 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
        >
          <div className="flex min-w-0 items-center gap-2">
            <Dialog.Title className="min-w-0 truncate font-heading text-sm font-medium">
              {name}
            </Dialog.Title>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {outputTime(output)} · {formatBytes(output.size)}
            </span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              data-testid="output-viewer-thread"
              onClick={() => {
                onClose();
                actions.openThread(output.threadId);
              }}
            >
              <MessageSquare data-icon="inline-start" />
              <span className="max-w-48 truncate">{output.threadTitle || "Open thread"}</span>
            </Button>
            {canReveal && (
              <Button size="sm" variant="ghost" onClick={() => actions.reveal(output)}>
                <FolderOpen data-icon="inline-start" />
                {revealLabel()}
              </Button>
            )}
          </div>
          {src === undefined ? (
            <PanelMessage loading>Loading {name}…</PanelMessage>
          ) : (
            <img src={src} alt={name} className="min-h-0 flex-1 object-contain" />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A workspace's Files: the screenshots, recordings, images and documents its orchestrator and
 * workers produced, as thumbnails by day or feature. A picture opens here at full size; anything
 * else opens in its thread's Files panel. Every read goes through the thread that made it.
 */
export function OutputsView({ workspaceId }: { workspaceId: WorkspaceId }) {
  const api = useApi();
  const { workspaces, settled, error } = useWorkspacesQuery();
  const state = workspaces.find((candidate) => candidate.workspace.id === workspaceId);
  const [filter, setFilter] = useState<OutputFilter>("all");
  const [grouping, setGrouping] = useState<OutputGrouping>("day");
  const [viewing, setViewing] = useState<WorkspaceOutput>();
  const now = useNow(true, undefined, 60_000);
  const actions = useOutputActions();
  const canReveal = useFeature("revealInFileManager");
  const pages = useInfiniteQuery({
    queryKey: ["outputs", workspaceId, filter],
    queryFn: ({ pageParam }) =>
      api.listOutputs(workspaceId, {
        ...(filter === "all" ? {} : { kind: filter }),
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next,
    enabled: state !== undefined,
    retry: false,
  });
  const outputs = useMemo(
    () => pages.data?.pages.flatMap((page) => page.outputs) ?? [],
    [pages.data],
  );
  const groups = useMemo(() => groupOutputs(outputs, grouping, now), [outputs, grouping, now]);

  if (!settled) return <PanelMessage loading>Loading files…</PanelMessage>;
  if (error) return <QueryError error={error} feature="Files" />;
  if (state === undefined) {
    return (
      <div
        role="status"
        data-testid="outputs-missing"
        className="p-8 text-center text-sm text-muted-foreground"
      >
        No such workspace.
      </div>
    );
  }

  const open = (output: WorkspaceOutput) =>
    outputViewer(output) === "panel" ? actions.inPanel(output) : setViewing(output);

  return (
    <div data-testid="outputs-view" className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5">
        <h1 className="flex min-w-0 items-center gap-2 text-[15px] font-medium">
          <Images aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">Files · {state.workspace.name}</span>
        </h1>
        <Segments
          label="Kind"
          values={OUTPUT_FILTERS}
          labels={OUTPUT_FILTER_LABELS}
          value={filter}
          onChange={setFilter}
        />
        <span className="flex-1" />
        <Segments
          label="Group by"
          values={OUTPUT_GROUPINGS}
          labels={OUTPUT_GROUPING_LABELS}
          value={grouping}
          onChange={setGrouping}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-6">
        {pages.status === "error" ? (
          <QueryError error={pages.error} feature="Files" />
        ) : pages.status === "pending" ? (
          <PanelMessage loading>Loading files…</PanelMessage>
        ) : outputs.length === 0 ? (
          <div
            role="status"
            data-testid="outputs-empty"
            className="flex flex-col items-center gap-1 p-10 text-center text-sm text-muted-foreground"
          >
            <Images aria-hidden strokeWidth={1.5} className="mb-1 size-6 opacity-70" />
            <p className="text-foreground">No files yet</p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <section key={group.key} aria-label={group.label} data-testid="output-group">
                <h2 className="mb-2 text-xs font-medium text-muted-foreground">
                  {group.label}
                  <span className="ml-1.5 font-normal tabular-nums">{group.outputs.length}</span>
                </h2>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-3 gap-y-4">
                  {group.outputs.map((output) => (
                    <Tile key={output.id} output={output} onOpen={open} canReveal={canReveal} />
                  ))}
                </ul>
              </section>
            ))}
            {pages.hasNextPage && (
              <Button
                size="sm"
                variant="ghost"
                className="self-center"
                data-testid="outputs-more"
                disabled={pages.isFetchingNextPage}
                onClick={() => void pages.fetchNextPage()}
              >
                More
              </Button>
            )}
          </div>
        )}
      </div>
      {viewing !== undefined && (
        <Viewer output={viewing} canReveal={canReveal} onClose={() => setViewing(undefined)} />
      )}
    </div>
  );
}
