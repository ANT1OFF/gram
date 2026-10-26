import type { ThreadId, ThreadSummary, WorktreeEntry } from "@gram/contracts";
import { useIsFetching, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleCheck, FolderGit2, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/time";
import { focusIfConnected, focusLost } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/motion";
import { baseName } from "@/new-thread/path";
import { closeThread, useThreadsStore } from "@/stores/threads";
import { closeWarning } from "@/thread/close-warning";
import { Dialog, DialogShell } from "@/thread/dialog-shell";
import { branchDeleteLooksSafe, mergedPrRef } from "@/thread/merged-cleanup";
import {
  DirtyAlert,
  PermissionChecklist,
  useSkippedRules,
  worktreeDirtyCount,
} from "@/thread/removal-checklist";
import { formatBytes } from "@/thread/orchestration-model";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { finishedWorker, type FinishedWorker } from "./finished-worker";

const rulesKey = (path: string) => ["worktree.pendingPermissionsAt", path] as const;
const sizeKey = (path: string) => ["worktree.size", path] as const;
const NONE: ReadonlySet<string> = new Set();
const finishedWorkerAt = (
  summary: ThreadSummary | undefined,
  details: Readonly<Record<string, string>>,
) => finishedWorker(summary, summary === undefined ? undefined : details[summary.thread.id]);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const worktreeCount = (count: number) => plural(count, "worktree");

const removedStatus = (removed: readonly WorktreeEntry[], closed: number): string => {
  const [only] = removed;
  const threads =
    closed === 0
      ? ""
      : ` and closed ${removed.length === 1 ? "its worker" : plural(closed, "finished worker")}`;
  if (removed.length === 1 && only !== undefined) {
    return `Removed the worktree folder ${baseName(only.path)}${threads}. ${
      only.branch ? `The branch ${only.branch} and its commits are kept.` : "Its commits are kept."
    }`;
  }
  return `Removed ${removed.length} worktree folders${threads}. Their branches and commits are kept.`;
};

/** What the worktrees at `paths` take on disk, in words; `undefined` while a count still runs. */
function useSelectionSize(paths: readonly string[]): string | undefined {
  const api = useApi();
  const sizes = useQueries({
    queries: paths.map((path) => ({
      queryKey: sizeKey(path),
      queryFn: () => api.worktreeSize(path),
      retry: false,
      staleTime: 60_000,
    })),
  });
  if (sizes.some((size) => size.status === "pending")) return undefined;
  if (sizes.every((size) => size.status === "error")) return "size unknown";
  const bytes = sizes.reduce((sum, size) => sum + (size.data?.bytes ?? 0), 0);
  const lowerBound = sizes.some((size) => size.status === "error" || size.data?.partial === true);
  return `${lowerBound ? "at least " : ""}${formatBytes(bytes)}`;
}

/**
 * A repo's worktrees: which thread uses each, uncommitted and unmerged work, and removal of the
 * ones no thread uses, one at a time or several at once (with the close dialog's permission
 * checklist and dirty confirmation). Archived and merged workers' worktrees can be picked in bulk
 * too, and each goes by closing its worker.
 */
export function WorktreesDialog({ repoPath, onClose }: { repoPath: string; onClose: () => void }) {
  const api = useApi();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["worktree.list", repoPath],
    queryFn: () => api.listWorktrees(repoPath),
    retry: false,
  });
  const threads = useThreadsStore((s) => s.byId);
  const details = useThreadsStore((s) => s.statusDetail);
  const [removed, setRemoved] = useState<{
    readonly entries: readonly WorktreeEntry[];
    readonly closed: number;
  }>({ entries: [], closed: 0 });
  const [selected, setSelected] = useState<ReadonlySet<string>>(NONE);
  const [bulk, setBulk] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const worktrees = (query.data?.worktrees ?? []).toSorted(
    (a, b) => Number(b.isMain) - Number(a.isMain),
  );

  // Preserve the first owner in store order when more than one thread names a checkout.
  const owners = new Map<string, ThreadSummary>();
  for (const summary of Object.values(threads)) {
    const path = summary.thread.checkout.path;
    if (!owners.has(path)) owners.set(path, summary);
  }
  const rows = worktrees.map((entry) => {
    const user = owners.get(entry.path);
    const finished = entry.isMain ? undefined : finishedWorkerAt(user, details);
    // The server's isOpen protects checkouts before the local thread list catches up.
    const removable =
      !entry.isMain &&
      ((!entry.isOpen && user?.thread.title === undefined) || finished !== undefined);
    return { entry, user, finished, removable };
  });
  const pickedRows = rows.filter(({ entry, removable }) => selected.has(entry.path) && removable);
  const picked = pickedRows.map(({ entry }) => entry);
  const closing = new Map(
    pickedRows.flatMap(({ entry, user, finished }) =>
      finished === undefined || user === undefined ? [] : [[entry.path, user.thread.id] as const],
    ),
  );
  const finishedRows = rows.filter((row) => row.finished !== undefined);
  const unpickedFinished = finishedRows.filter(({ entry }) => !selected.has(entry.path));
  const size = useSelectionSize(picked.map((entry) => entry.path));

  const toggle = (path: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const selectFinished = () =>
    setSelected((current) => new Set([...current, ...finishedRows.map(({ entry }) => entry.path)]));
  const onRemoved = (entries: readonly WorktreeEntry[], closed = 0) => {
    if (entries.length === 0) return;
    setRemoved({ entries, closed });
    setSelected(
      (current) => new Set([...current].filter((path) => !entries.some((e) => e.path === path))),
    );
    // The removed row took focus with it; the status line says what happened.
    setTimeout(() => {
      if (focusLost()) focusIfConnected(statusRef.current);
    }, 0);
  };

  return (
    <DialogShell
      testId="worktrees-dialog"
      title="Worktrees"
      description={query.data?.repoTop ?? repoPath}
      onClose={onClose}
    >
      {removed.entries.length > 0 && (
        <p
          ref={statusRef}
          role="status"
          tabIndex={-1}
          className="text-xs text-muted-foreground outline-none"
        >
          {removedStatus(removed.entries, removed.closed)}
        </p>
      )}
      {query.status === "pending" ? (
        <p className="text-xs text-muted-foreground">
          <Shimmer>Loading worktrees…</Shimmer>
        </p>
      ) : query.status === "error" ? (
        <p role="alert" className="text-xs text-destructive">
          Couldn't list the worktrees: {errorMessage(query.error)}
        </p>
      ) : (
        <>
          {unpickedFinished.length > 0 && (
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                {plural(finishedRows.length, "worktree")} of archived or merged workers
              </span>
              <Button size="xs" variant="outline" onClick={selectFinished}>
                Select {finishedRows.length === 1 ? "it" : `all ${finishedRows.length}`}
              </Button>
            </div>
          )}
          {/* The dialog sits 20% down and doesn't scroll, so the two lists share what's left. */}
          <ul
            aria-label="Worktrees"
            className={cn(
              "-mx-1 flex flex-col overflow-y-auto",
              bulk && picked.length > 0 ? "max-h-[20vh]" : "max-h-[50vh]",
            )}
          >
            {rows.map(({ entry, user, finished, removable }) => (
              <WorktreeRow
                key={entry.path}
                entry={entry}
                user={user}
                finished={finished}
                {...(removable
                  ? { selected: selected.has(entry.path), onToggle: () => toggle(entry.path) }
                  : {})}
                onRemoved={() => onRemoved([entry])}
              />
            ))}
          </ul>
        </>
      )}
      {picked.length > 0 &&
        (bulk ? (
          <BulkRemove
            entries={picked}
            closing={closing}
            size={size}
            onCancel={() => setBulk(false)}
            onRemoved={(entries, closed, done) => {
              onRemoved(entries, closed);
              if (done) setBulk(false);
            }}
          />
        ) : (
          <div className="flex items-center justify-between gap-2 text-xs">
            <span data-testid="worktree-selection" className="text-muted-foreground">
              {picked.length} selected · {size ?? <Shimmer>sizing…</Shimmer>}
            </span>
            <Button size="xs" variant="outline" onClick={() => setBulk(true)}>
              Remove {worktreeCount(picked.length)}…
            </Button>
          </div>
        ))}
      {/* Close first, so it keeps the focus the dialog opens with; drawn on the right. */}
      <div className="flex flex-row-reverse justify-between gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Close
        </Dialog.Close>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onClose();
            void navigate({ to: "/settings/storage" });
          }}
        >
          All repos in Storage
        </Button>
      </div>
    </DialogShell>
  );
}

function WorktreeRow({
  entry,
  user,
  finished,
  selected,
  onToggle,
  onRemoved,
}: {
  entry: WorktreeEntry;
  user: ThreadSummary | undefined;
  finished: FinishedWorker | undefined;
  /** Present only for a worktree no thread uses, or one a finished worker does. */
  selected?: boolean;
  onToggle?: () => void;
  onRemoved: () => void;
}) {
  const threadTitle = user?.thread.title;
  const merged = mergedPrRef(user);
  const [confirming, setConfirming] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const cancelRemove = () => {
    setConfirming(false);
    setTimeout(() => {
      if (focusLost()) focusIfConnected(rowRef.current?.querySelector("[data-remove-trigger]"));
    }, 0);
  };
  const name = entry.isMain ? "Main checkout" : (entry.branch ?? baseName(entry.path));
  const inUse = threadTitle !== undefined || entry.isOpen;
  const usage =
    threadTitle !== undefined
      ? `Used by “${threadTitle}”`
      : entry.isOpen
        ? "open in a thread"
        : "No thread";

  return (
    <li
      ref={rowRef}
      data-testid="worktree-row"
      aria-label={name}
      className="flex flex-col gap-1 border-b border-border px-1 py-2 last:border-b-0"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {onToggle ? (
          <input
            type="checkbox"
            aria-label={`Select ${name}`}
            checked={selected === true}
            onChange={onToggle}
            className="size-3.5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        ) : (
          <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-mono text-xs font-medium">{name}</span>
        {entry.isMain && entry.branch && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {entry.branch}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{usage}</span>
        {entry.lastActivity > 0 && (
          <time
            dateTime={new Date(entry.lastActivity).toISOString()}
            className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
          >
            {formatRelative(entry.lastActivity)}
          </time>
        )}
      </div>
      <p className="truncate pl-5.5 font-mono text-[11px] text-muted-foreground" title={entry.path}>
        {entry.path}
      </p>
      {!entry.isMain && (
        <div className="flex flex-col gap-1.5 pl-5.5">
          <WorktreeStatus path={entry.path} />
          {merged !== undefined && user !== undefined ? (
            <div className="flex items-center gap-2">
              <span data-testid="worktree-merged" className="text-xs text-merged">
                #{merged.number} merged
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  useThreadDialogs.getState().open({
                    kind: "close",
                    threadId: user.thread.id,
                    preset: { removeWorktree: true, deleteBranch: branchDeleteLooksSafe(user.git) },
                  })
                }
              >
                Close and clean up…
              </Button>
            </div>
          ) : finished !== undefined ? (
            <p data-testid="worktree-finished" className="text-xs text-muted-foreground">
              {finished === "archived" ? "Archived" : "Merged"} worker: select it to close it and
              remove its worktree
            </p>
          ) : inUse ? (
            <p className="text-xs text-muted-foreground">Close the thread to remove its worktree</p>
          ) : confirming ? (
            <RemoveConfirm entry={entry} onCancel={cancelRemove} onRemoved={onRemoved} />
          ) : (
            <Button
              data-remove-trigger
              size="xs"
              variant="outline"
              className="w-fit"
              onClick={() => setConfirming(true)}
            >
              Remove…
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function WorktreeStatus({ path }: { path: string }) {
  const api = useApi();
  const status = useQuery({
    queryKey: ["worktree.status", path],
    queryFn: () => api.worktreeStatus(path),
    retry: false,
  });
  if (status.status === "pending") {
    return (
      <p className="text-xs text-muted-foreground">
        <Shimmer>Checking for uncommitted work…</Shimmer>
      </p>
    );
  }
  if (status.status === "error") {
    return (
      <p role="alert" className="text-xs text-destructive">
        Couldn't read its git status: {errorMessage(status.error)}
      </p>
    );
  }
  const warning = closeWarning(status.data);
  return warning ? (
    <p data-testid="worktree-warning" className="flex items-start gap-1.5 text-xs">
      <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0 text-status-needs" />
      {warning}
    </p>
  ) : (
    <p data-testid="worktree-clean" className="flex items-center gap-1.5 text-xs">
      <CircleCheck aria-hidden className="size-3 shrink-0 text-success" />
      Clean
    </p>
  );
}

function RemoveConfirm({
  entry,
  onCancel,
  onRemoved,
}: {
  entry: WorktreeEntry;
  onCancel: () => void;
  onRemoved: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const ruleChoice = useSkippedRules();
  const [dirty, setDirty] = useState<number | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const rules = useQuery({
    queryKey: rulesKey(entry.path),
    queryFn: () => api.worktreePendingPermissions(entry.path),
    retry: false,
  });

  const submit = async (force: boolean) => {
    setPending(true);
    setError(undefined);
    const picked = ruleChoice.picked(rules.data);
    try {
      await api.removeWorktree(entry.path, {
        force,
        ...(picked.length > 0 ? { permissionRules: picked } : {}),
      });
      queryClient.removeQueries({ queryKey: ["worktree.status", entry.path] });
      void queryClient.invalidateQueries({ queryKey: ["worktree.list"] });
      onRemoved();
    } catch (e) {
      const changed = worktreeDirtyCount(e);
      if (changed === undefined) setError(errorMessage(e));
      else setDirty(changed);
      setPending(false);
    }
  };

  return (
    <div
      data-testid="worktree-remove"
      className="flex flex-col gap-2 rounded-md border border-border bg-card/40 p-2"
    >
      <p className="text-xs text-muted-foreground">
        The worktree folder will be removed. The branch and its commits are kept.
      </p>
      <PermissionChecklist
        rules={rules}
        skipped={ruleChoice.skipped}
        onToggle={ruleChoice.toggle}
      />
      {dirty !== undefined && <DirtyAlert changedFiles={dirty} />}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {dirty === undefined ? (
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={pending || rules.status === "pending"}
            onClick={() => void submit(false)}
          >
            Delete worktree
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={pending}
            onClick={() => void submit(true)}
          >
            Delete anyway
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Removes several worktrees in turn, each with its own permission checklist: unused ones directly,
 * and a finished worker's by closing the worker with it. Dirty ones are refused and shown; a second,
 * forced pass deletes only those. Branches are never deleted.
 */
function BulkRemove({
  entries,
  closing,
  size,
  onCancel,
  onRemoved,
}: {
  entries: readonly WorktreeEntry[];
  /** The finished worker to close with each worktree it uses, by path. */
  closing: ReadonlyMap<string, ThreadId>;
  /** What the entries take on disk, in words; `undefined` while still counting. */
  size: string | undefined;
  onCancel: () => void;
  /** `closed` workers went with them; `done` once nothing was refused. */
  onRemoved: (removed: readonly WorktreeEntry[], closed: number, done: boolean) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const loadingRules = useIsFetching({ queryKey: ["worktree.pendingPermissionsAt"] }) > 0;
  const [skipped, setSkipped] = useState<Readonly<Record<string, ReadonlySet<string>>>>({});
  const [dirty, setDirty] = useState<Readonly<Record<string, number>>>({});
  const [failed, setFailed] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState(false);
  const dirtyCount = Object.keys(dirty).length;
  const forcing = dirtyCount > 0;

  const toggle = (path: string, rule: string) =>
    setSkipped((current) => {
      const next = new Set(current[path]);
      if (next.has(rule)) next.delete(rule);
      else next.add(rule);
      return { ...current, [path]: next };
    });

  const submit = async () => {
    setPending(true);
    const targets = forcing ? entries.filter((entry) => dirty[entry.path] !== undefined) : entries;
    const removed: WorktreeEntry[] = [];
    let closed = 0;
    const nextDirty: Record<string, number> = {};
    const nextFailed: Record<string, string> = {};
    for (const entry of targets) {
      const rules = queryClient.getQueryData<readonly string[]>(rulesKey(entry.path)) ?? [];
      const picked = rules.filter((rule) => !skipped[entry.path]?.has(rule));
      const chosen = picked.length > 0 ? { permissionRules: picked } : {};
      const worker = closing.get(entry.path);
      // The selection was taken before the loop's first await: a worker may have started since.
      // It drops out of the selection by itself, and its row says a thread uses it.
      const now = useThreadsStore.getState();
      if (worker !== undefined && !finishedWorkerAt(now.byId[worker], now.statusDetail)) {
        continue;
      }
      try {
        await (worker === undefined
          ? api.removeWorktree(entry.path, { force: forcing, ...chosen })
          : closeThread(api, worker, {
              removeWorktree: { force: forcing },
              onlyAtRest: true,
              ...chosen,
            }));
        queryClient.removeQueries({ queryKey: ["worktree.status", entry.path] });
        queryClient.removeQueries({ queryKey: sizeKey(entry.path) });
        removed.push(entry);
        if (worker !== undefined) closed += 1;
      } catch (e) {
        const changed = worktreeDirtyCount(e);
        if (changed === undefined) nextFailed[entry.path] = errorMessage(e);
        else nextDirty[entry.path] = changed;
      }
    }
    setDirty(nextDirty);
    setFailed(nextFailed);
    setPending(false);
    void queryClient.invalidateQueries({ queryKey: ["worktree.list"] });
    onRemoved(
      removed,
      closed,
      Object.keys(nextDirty).length === 0 && Object.keys(nextFailed).length === 0,
    );
  };

  return (
    <div
      data-testid="worktree-bulk-remove"
      className="flex flex-col gap-2 rounded-md border border-border bg-card/40 p-2"
    >
      <p className="text-xs text-muted-foreground">
        These worktree folders will be removed, freeing {size ?? "…"}. Their branches and commits
        are kept.
        {closing.size > 0 &&
          ` ${plural(closing.size, "finished worker")} using them ${closing.size === 1 ? "is" : "are"} closed too.`}
      </p>
      <ul className="flex max-h-[25vh] flex-col gap-2 overflow-y-auto">
        {entries.map((entry) => (
          <BulkEntry
            key={entry.path}
            entry={entry}
            skipped={skipped[entry.path] ?? NONE}
            onToggle={(rule) => toggle(entry.path, rule)}
            dirty={dirty[entry.path]}
            error={failed[entry.path]}
          />
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="xs"
          variant="destructive"
          disabled={pending || loadingRules}
          onClick={() => void submit()}
        >
          {forcing
            ? `Delete ${worktreeCount(dirtyCount)} anyway`
            : `Delete ${worktreeCount(entries.length)}`}
        </Button>
      </div>
    </div>
  );
}

function BulkEntry({
  entry,
  skipped,
  onToggle,
  dirty,
  error,
}: {
  entry: WorktreeEntry;
  skipped: ReadonlySet<string>;
  onToggle: (rule: string) => void;
  dirty: number | undefined;
  error: string | undefined;
}) {
  const api = useApi();
  const rules = useQuery({
    queryKey: rulesKey(entry.path),
    queryFn: () => api.worktreePendingPermissions(entry.path),
    retry: false,
  });
  const name = entry.branch ?? baseName(entry.path);

  return (
    <li
      aria-label={`Remove ${name}`}
      className="flex flex-col gap-1.5 border-b border-border pb-2 last:border-b-0 last:pb-0"
    >
      <span className="font-mono text-xs font-medium">{name}</span>
      <PermissionChecklist rules={rules} skipped={skipped} onToggle={onToggle} />
      {dirty !== undefined && <DirtyAlert changedFiles={dirty} />}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}
