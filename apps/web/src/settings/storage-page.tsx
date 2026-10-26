import {
  CLEANUP_INACTIVE_DAYS,
  worktreeSweepOf,
  type ConfirmedRemoval,
  type CleanUpResult,
  type SettingsPatch,
  type StorageGroup,
  type StorageWorktree,
} from "@gram/contracts";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderGit2, HardDrive } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import {
  revealLabel,
  useOpenInEditor,
  useOpensLocally,
  useRevealInFileManager,
} from "@/editor/use-open-in-editor";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/motion";
import { useServerSettings } from "@/settings-sync/store";
import { useOpenThread } from "@/shell/thread-switcher";
import { Dialog, DialogShell } from "@/thread/dialog-shell";
import { formatBytes } from "@/thread/orchestration-model";

import { NumberField, OptionGroup, Toggle } from "./fields";
import { SETTINGS_CARD } from "./settings-group";
import {
  bulkTargets,
  GROUP_HINTS,
  rowState,
  sizeLabel,
  STORAGE_GROUPS,
  sumSizes,
  workAtRisk,
  worktreeCount,
  worktreeName,
} from "./storage-model";
import { useSaveSettings } from "./use-save-settings";

const STORAGE_KEY = ["worktree.storage"] as const;
const sizeKey = (path: string) => ["worktree.size", path] as const;

/** Groups listed open when the page loads; a long one starts folded. */
const OPEN_UP_TO = 8;

type Size = { readonly bytes: number; readonly partial: boolean } | "error";

/** What a pending confirmation removes, and how it is worded. */
interface Pending {
  readonly title: string;
  readonly entries: readonly StorageWorktree[];
  readonly confirmLabel: string;
  /** The worktree the user is confirming by name, with the work the dialog shows. */
  readonly confirmed?: readonly ConfirmedRemoval[];
  readonly prune?: boolean;
}

/**
 * Settings › Storage: every repo's worktrees grouped by what removing them would lose, with their
 * sizes, the free disk space, and cleanups. Nothing with uncommitted or unpushed work goes without
 * a confirmation that names it.
 */
export function StoragePage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const report = useQuery({
    queryKey: STORAGE_KEY,
    queryFn: () => api.storageReport(),
    retry: false,
  });
  const worktrees = report.data?.worktrees ?? [];
  const sized = worktrees.filter((entry) => !entry.missing);
  const sizeQueries = useQueries({
    queries: sized.map((entry) => ({
      queryKey: sizeKey(entry.path),
      queryFn: () => api.worktreeSize(entry.path),
      retry: false,
      staleTime: 60_000,
    })),
  });
  const sizes = new Map<string, Size>();
  sized.forEach((entry, index) => {
    const query = sizeQueries[index];
    if (query?.status === "success") sizes.set(entry.path, query.data);
    else if (query?.status === "error") sizes.set(entry.path, "error");
  });
  const [pending, setPending] = useState<Pending>();
  const [planning, setPlanning] = useState<number>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  const afterCleanUp = (result: CleanUpResult) => {
    setStatus(cleanUpStatus(result));
    for (const removed of result.removed) {
      queryClient.removeQueries({ queryKey: sizeKey(removed.path) });
    }
    void queryClient.invalidateQueries({ queryKey: STORAGE_KEY });
    void queryClient.invalidateQueries({ queryKey: ["worktree.list"] });
  };

  const run = async (target: Pending) => {
    setError(undefined);
    try {
      afterCleanUp(
        await api.cleanUpWorktrees(
          target.entries.map((entry) => entry.path),
          {
            ...(target.confirmed === undefined ? {} : { confirmed: target.confirmed }),
            ...(target.prune === undefined ? {} : { prune: target.prune }),
          },
        ),
      );
      setPending(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = (entry: StorageWorktree) => {
    const risk = workAtRisk(entry);
    // Gram's own with nothing to lose: no question asked. Work at risk, or another tool's: a
    // confirmation that names it, and the server keeps it if more work turns up meanwhile.
    if (entry.missing || (risk === undefined && entry.madeByGram)) {
      // A gone folder's own repo is pruned; the others are left alone.
      void run({ title: "", entries: [entry], confirmLabel: "" });
      return;
    }
    setPending({
      title: `Remove ${worktreeName(entry)}?`,
      entries: [entry],
      confirmLabel: risk === undefined ? "Remove" : "Remove and lose it",
      confirmed: [{ path: entry.path, changedFiles: entry.changedFiles, unpushed: entry.unpushed }],
    });
  };

  return (
    <div className="flex flex-col gap-5 text-sm" data-testid="storage-page">
      <DiskSummary
        free={report.data?.disk?.freeBytes}
        total={report.data?.disk?.totalBytes}
        worktrees={sumSizes(worktrees, sizes)}
        count={worktrees.length}
      />
      <div className={SETTINGS_CARD}>
        <CleanUpInactive onReview={setPlanning} />
        <AutomaticCleanup />
      </div>
      {status !== undefined && (
        <p
          role="status"
          data-testid="storage-status"
          className="px-1 text-xs text-muted-foreground"
        >
          {status}
        </p>
      )}
      {error !== undefined && pending === undefined && (
        <p role="alert" className="px-1 text-xs text-destructive">
          {error}
        </p>
      )}
      {report.status === "pending" ? (
        <p className="px-1 text-xs text-muted-foreground">
          <Shimmer>Reading worktrees…</Shimmer>
        </p>
      ) : report.status === "error" ? (
        <p role="alert" className="px-1 text-xs text-destructive">
          Couldn't read the worktrees: {errorMessage(report.error)}
        </p>
      ) : (
        STORAGE_GROUPS.map(({ group, label }) => (
          <GroupSection
            key={group}
            group={group}
            label={label}
            entries={worktrees.filter((entry) => entry.group === group)}
            sizes={sizes}
            onRemove={remove}
            onBulk={(targets) =>
              setPending({
                title:
                  group === "foreign"
                    ? `Prune ${targets.length} stale registration${targets.length === 1 ? "" : "s"}?`
                    : `Remove ${worktreeCount(targets.length)}?`,
                entries: targets,
                confirmLabel: group === "foreign" ? "Prune" : "Remove",
                ...(group === "foreign" ? { prune: true } : {}),
              })
            }
          />
        ))
      )}
      {report.data !== undefined && report.data.failedRepos.length > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          Couldn't list: {report.data.failedRepos.join(", ")}
        </p>
      )}
      {planning !== undefined && (
        <InactivePlan
          days={planning}
          onClose={() => setPlanning(undefined)}
          onConfirm={(target) => {
            setPlanning(undefined);
            void run(target);
          }}
        />
      )}
      {pending !== undefined && (
        <ConfirmRemoval
          pending={pending}
          bytes={sizeLabel(sumSizes(pending.entries, sizes))}
          error={error}
          onCancel={() => {
            setPending(undefined);
            setError(undefined);
          }}
          onConfirm={() => run(pending)}
        />
      )}
    </div>
  );
}

const cleanUpStatus = (result: CleanUpResult): string => {
  const parts: string[] = [];
  if (result.removed.length > 0) {
    parts.push(
      `Removed ${worktreeCount(result.removed.length)}, ${formatBytes(result.bytes)} freed. Branches kept.`,
    );
  }
  if (result.pruned > 0)
    parts.push(`Pruned ${result.pruned} stale registration${result.pruned === 1 ? "" : "s"}.`);
  if (result.kept.length > 0) {
    const [first] = result.kept;
    parts.push(
      result.kept.length === 1 && first !== undefined
        ? `Kept one: ${first.reason}.`
        : `Kept ${result.kept.length}: they changed since the page loaded.`,
    );
  }
  return parts.join(" ") || "Nothing to clean up.";
};

function DiskSummary({
  free,
  total,
  worktrees,
  count,
}: {
  free: number | undefined;
  total: number | undefined;
  worktrees: ReturnType<typeof sumSizes>;
  count: number;
}) {
  const used = total !== undefined && free !== undefined ? total - free : undefined;
  return (
    <div className={cn(SETTINGS_CARD, "gap-2")} data-testid="storage-disk">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <HardDrive aria-hidden className="size-4 text-muted-foreground" />
          <span className="font-medium">
            {free === undefined ? "Free space unknown" : `${formatBytes(free)} free`}
          </span>
          {total !== undefined && (
            <span className="text-xs text-muted-foreground">of {formatBytes(total)}</span>
          )}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {worktreeCount(count)} · {sizeLabel(worktrees)}
          </span>
        </div>
        {used !== undefined && total !== undefined && total > 0 && (
          <div
            role="meter"
            aria-label="Disk used"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={used}
            className="flex h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="bg-foreground/35"
              style={{ width: `${(Math.max(0, used - worktrees.bytes) / total) * 100}%` }}
            />
            <div
              className="bg-primary"
              style={{ width: `${(Math.min(used, worktrees.bytes) / total) * 100}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function CleanUpInactive({ onReview }: { onReview: (days: number) => void }) {
  const [days, setDays] = useState<string>(String(CLEANUP_INACTIVE_DAYS[0]));
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex min-w-48 flex-1 flex-col gap-0.5">
        <span className="font-medium">Clean up inactive</span>
        <span className="text-xs text-muted-foreground">
          Clean, pushed worktrees no thread uses. Branches stay.
        </span>
      </div>
      <OptionGroup
        label="Inactive for"
        options={CLEANUP_INACTIVE_DAYS.map((n) => ({ value: String(n), label: `${n} days` }))}
        value={days}
        onChange={setDays}
      />
      <Button
        size="sm"
        variant="outline"
        data-testid="storage-cleanup-inactive"
        onClick={() => onReview(Number(days))}
      >
        Review…
      </Button>
    </div>
  );
}

/** The plan "Clean up inactive" works out first, then the one confirmation. */
function InactivePlan({
  days,
  onClose,
  onConfirm,
}: {
  days: number;
  onClose: () => void;
  onConfirm: (target: Pending) => void;
}) {
  const api = useApi();
  const plan = useQuery({
    queryKey: ["worktree.cleanupPlan", days],
    queryFn: () => api.cleanupPlan(days),
    retry: false,
    gcTime: 0,
  });
  const entries = plan.data?.worktrees ?? [];
  return (
    <DialogShell
      testId="storage-inactive-plan"
      title={`Clean up worktrees inactive for ${days} days`}
      onClose={onClose}
    >
      {plan.status === "pending" ? (
        <p className="text-xs text-muted-foreground">
          <Shimmer>Working out what goes…</Shimmer>
        </p>
      ) : plan.status === "error" ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(plan.error)}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-sm">Nothing inactive that long.</p>
      ) : (
        <>
          <p className="text-sm" data-testid="storage-plan-summary">
            {worktreeCount(entries.length)}, {plan.data.partial ? "at least " : ""}
            {formatBytes(plan.data.bytes)}. Branches stay, so any can be restored.
          </p>
          <EntryList entries={entries} />
        </>
      )}
      <div className="flex justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        {entries.length > 0 && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => onConfirm({ title: "", entries, confirmLabel: "" })}
          >
            Remove {worktreeCount(entries.length)}
          </Button>
        )}
      </div>
    </DialogShell>
  );
}

function ConfirmRemoval({
  pending,
  bytes,
  error,
  onCancel,
  onConfirm,
}: {
  pending: Pending;
  bytes: string;
  error: string | undefined;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [only] = pending.entries;
  const named = only !== undefined && pending.confirmed !== undefined ? only : undefined;
  const risk = named === undefined ? undefined : workAtRisk(named);
  return (
    <DialogShell testId="storage-confirm" title={pending.title} onClose={onCancel}>
      {named !== undefined ? (
        <p className="text-sm" data-testid="storage-confirm-risk">
          <span className="font-mono text-xs">{named.path}</span>{" "}
          {risk !== undefined
            ? `has ${risk}. They're lost for good.`
            : "wasn't made by Gram. Its folder is deleted; its branch stays."}
        </p>
      ) : pending.prune === true ? (
        <>
          <p className="text-sm">Their folders are already gone; this drops git's records.</p>
          <EntryList entries={pending.entries} />
        </>
      ) : (
        <>
          <p className="text-sm">{bytes}. Branches stay.</p>
          <EntryList entries={pending.entries} />
        </>
      )}
      {error !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onConfirm().finally(() => setBusy(false));
          }}
        >
          {pending.confirmLabel}
        </Button>
      </div>
    </DialogShell>
  );
}

function EntryList({ entries }: { entries: readonly StorageWorktree[] }) {
  return (
    <ul className="-mx-1 flex max-h-[40vh] flex-col overflow-y-auto text-xs">
      {entries.map((entry) => (
        <li key={entry.path} className="flex min-w-0 gap-2 px-1 py-1">
          <span className="shrink-0 font-mono font-medium">{worktreeName(entry)}</span>
          <span className="truncate font-mono text-muted-foreground" title={entry.path}>
            {entry.path}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AutomaticCleanup() {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const [error, setError] = useState<string>();
  if (settings === undefined) return null;
  const sweep = worktreeSweepOf(settings);
  const saveSweep = (patch: NonNullable<SettingsPatch["workspaces"]>) => {
    setError(undefined);
    save({ workspaces: patch }).catch((e: unknown) => setError(errorMessage(e)));
  };
  return (
    <Toggle
      label="Clean up finished threads"
      description="Removes clean, pushed worktrees once the PR merges or after the days below."
      keywords={["sweep", "disk", "space", "node_modules", "worktrees", "garbage", "merged"]}
      checked={sweep !== undefined}
      error={error}
      onChange={(worktreeSweep) => saveSweep({ worktreeSweep })}
      detail={
        sweep !== undefined && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <NumberField
              label="Free node_modules after (days)"
              value={sweep.freeAfterDays}
              min={1}
              onCommit={(worktreeSweepFreeDays) => saveSweep({ worktreeSweepFreeDays })}
            />
            <NumberField
              label="Remove after (days)"
              keywords={["worktree"]}
              value={sweep.removeAfterDays}
              min={1}
              onCommit={(worktreeSweepRemoveDays) => saveSweep({ worktreeSweepRemoveDays })}
            />
          </div>
        )
      }
    />
  );
}

function GroupSection({
  group,
  label,
  entries,
  sizes,
  onRemove,
  onBulk,
}: {
  group: StorageGroup;
  label: string;
  entries: readonly StorageWorktree[];
  sizes: ReadonlyMap<string, Size>;
  onRemove: (entry: StorageWorktree) => void;
  onBulk: (targets: readonly StorageWorktree[]) => void;
}) {
  const [open, setOpen] = useState(entries.length <= OPEN_UP_TO);
  const targets = bulkTargets(group, entries);
  const total = sumSizes(entries, sizes);
  const id = `storage-group-${group}`;
  return (
    <section aria-labelledby={id} data-testid={id} className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center gap-2 px-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <h3
            id={id}
            className="font-caption text-xs font-medium tracking-wide text-muted-foreground uppercase"
          >
            {label}
          </h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {entries.length} · {entries.length === 0 ? "0 B" : sizeLabel(total)}
          </span>
        </button>
        {targets.length > 0 && (
          <Button size="xs" variant="outline" onClick={() => onBulk(targets)}>
            {group === "foreign" ? "Prune" : "Remove all"} {targets.length}…
          </Button>
        )}
      </div>
      {open && (
        <>
          <p className="px-1 text-xs text-muted-foreground">{GROUP_HINTS[group]}</p>
          {entries.length > 0 && (
            <ul className={SETTINGS_CARD} aria-label={label}>
              {entries.map((entry) => (
                <StorageRow
                  key={entry.path}
                  entry={entry}
                  size={sizes.get(entry.path)}
                  onRemove={() => onRemove(entry)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function StorageRow({
  entry,
  size,
  onRemove,
}: {
  entry: StorageWorktree;
  size: Size | undefined;
  onRemove: () => void;
}) {
  const openThread = useOpenThread();
  const openInEditor = useOpenInEditor();
  const reveal = useRevealInFileManager();
  const local = useOpensLocally();
  const state = rowState(entry);
  const name = worktreeName(entry);
  const risk = workAtRisk(entry) !== undefined;
  const repo = entry.repoTop.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.repoTop;
  return (
    <li data-testid="storage-row" aria-label={name} className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs font-medium">{name}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{repo}</span>
        {state !== undefined && (
          <span
            className={cn("shrink-0 text-[11px]", risk ? "text-warning" : "text-muted-foreground")}
          >
            {state}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {entry.missing
            ? "—"
            : size === undefined
              ? "…"
              : size === "error"
                ? "?"
                : formatBytes(size.bytes)}
        </span>
        {entry.lastActivity > 0 && (
          <time
            dateTime={new Date(entry.lastActivity).toISOString()}
            className="w-10 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums"
          >
            {formatRelative(entry.lastActivity)}
          </time>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1 pl-5.5">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
          title={entry.path}
        >
          {entry.threadTitle !== undefined ? `“${entry.threadTitle}” · ` : ""}
          {entry.path}
        </span>
        {entry.threadId !== undefined ? (
          <RowAction
            label={`Open the thread of ${name}`}
            onClick={() => openThread(entry.threadId!)}
          >
            Open thread
          </RowAction>
        ) : (
          local &&
          !entry.missing && (
            <RowAction label={`Open ${name}`} onClick={() => void openInEditor(entry.path)}>
              Open
            </RowAction>
          )
        )}
        {local && !entry.missing && (
          <RowAction label={revealLabel(name)} onClick={() => void reveal(entry.path)}>
            {revealLabel()}
          </RowAction>
        )}
        {entry.group !== "inUse" && entry.locked !== true && entry.unreadable !== true && (
          <RowAction
            label={`${entry.missing ? "Prune" : "Remove"} ${name}`}
            onClick={onRemove}
            destructive={risk}
          >
            {entry.missing ? "Prune" : risk ? "Remove…" : "Remove"}
          </RowAction>
        )}
      </div>
    </li>
  );
}

function RowAction({
  label,
  onClick,
  destructive = false,
  children,
}: {
  /** Names the row, since the visible text is the same on every one. */
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      size="xs"
      variant="ghost"
      aria-label={label}
      className={cn("shrink-0", destructive && "text-destructive")}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
