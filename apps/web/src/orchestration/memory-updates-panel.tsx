import {
  type Dream,
  type DreamId,
  type MemoryUpdateMode,
  memoryUpdateModeOf,
  type WorkspaceState,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { agoText } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

import { InlineConfirm } from "./inline-confirm";
import { dreamWaitsForReview, lastRun, revertable } from "./memory-model";

/** The schedules offered, in hours; absent runs none on a schedule. */
export const SCHEDULE_HOURS = [1, 3, 6, 12, 24] as const;

const hoursText = (hours: number): string => (hours === 1 ? "hour" : `${hours} hours`);

const MODE_TEXT: Record<MemoryUpdateMode, { readonly label: string; readonly note: string }> = {
  review: {
    label: "Review",
    note: "Each update is a draft: memory changes only when you adopt it.",
  },
  auto: {
    label: "Auto",
    note: "Each update applies itself as a new memory version, and tells you in one line. Revert undoes it. Your standing decisions change only by your word.",
  },
};

/**
 * A workspace's memory updates at a glance: whether they wait for review or apply themselves,
 * how often they run, the last run with what it changed, and Revert for one that applied itself.
 */
export function MemoryUpdatesPanel({
  state,
  dreams,
  busy,
  onSeeChanges,
}: {
  state: WorkspaceState;
  dreams: readonly Dream[];
  /** A run is under way, so another can't start. */
  busy: boolean;
  onSeeChanges: (dream: DreamId) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const workspaceId = state.workspace.id;
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(true, ref, 30_000);
  const mode = memoryUpdateModeOf(state.charter);
  const every = state.charter.memoryUpdateEveryHours;
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [error, setError] = useState<string>();
  const [reverted, setReverted] = useState(false);
  const modeLabel = useId();
  const scheduleId = useId();
  const versions = useQuery({
    queryKey: ["memory", workspaceId, "versions"],
    queryFn: () => api.listMemoryVersions(workspaceId),
    retry: false,
  });
  const current = versions.data?.find((version) => version.current)?.version;
  const waiting = dreams
    .filter(dreamWaitsForReview)
    .filter((dream) => dream.mode === "review" && dream.inputs.recent !== undefined);
  const last = lastRun(dreams);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
      queryClient.invalidateQueries({ queryKey: ["dreams", workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] }),
    ]);

  const save = (change: Partial<WorkspaceState["charter"]>, drop?: "memoryUpdateEveryHours") => {
    setSaving(true);
    setError(undefined);
    const { memoryUpdateEveryHours: _every, ...rest } = state.charter;
    const base = drop === undefined ? state.charter : rest;
    api
      .setOrchestratorCharter(workspaceId, { ...base, ...change })
      .then(refresh)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  const pickMode = (next: MemoryUpdateMode) => {
    if (next === mode) return;
    if (next === "auto" && waiting.length > 0) {
      setConfirmAuto(true);
      return;
    }
    setConfirmAuto(false);
    save({ memoryUpdateMode: next });
  };

  const updateNow = () => {
    setStarting(true);
    setError(undefined);
    api
      .startDream(workspaceId, { kind: "dream" })
      .then(refresh)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setStarting(false));
  };

  const revert = (dream: Dream) => {
    setReverting(true);
    setError(undefined);
    api
      .revertDream(dream.id)
      .then(async () => {
        setReverted(true);
        await refresh();
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setReverting(false));
  };

  return (
    <div
      ref={ref}
      data-testid="memory-updates"
      data-mode={mode}
      className="flex flex-col gap-3 rounded-(--radius-md) border border-edge bg-card/40 p-3"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span id={modeLabel} className="text-body-strong">
          Memory updates
        </span>
        <div
          role="radiogroup"
          aria-labelledby={modeLabel}
          data-testid="memory-update-mode"
          className="inline-flex rounded-(--radius-sm) border border-edge p-0.5"
        >
          {(["review", "auto"] as const).map((each) => (
            <label
              key={each}
              className={cn(
                "cursor-pointer rounded-(--radius-xs) px-2.5 py-0.5 text-meta has-focus-visible:ring-2 has-focus-visible:ring-ring",
                each === mode
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <input
                type="radio"
                className="sr-only"
                name={`${modeLabel}-mode`}
                value={each}
                checked={each === mode}
                disabled={saving}
                onChange={() => pickMode(each)}
              />
              {MODE_TEXT[each].label}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2 text-meta">
          <label htmlFor={scheduleId} className="text-muted-foreground">
            Run
          </label>
          <select
            id={scheduleId}
            data-testid="memory-update-schedule"
            className="h-7 rounded-(--radius-sm) border border-input bg-background px-1.5 text-meta"
            value={every === undefined ? "" : String(every)}
            disabled={saving}
            onChange={(event) =>
              event.target.value === ""
                ? save({}, "memoryUpdateEveryHours")
                : save({ memoryUpdateEveryHours: Number(event.target.value) })
            }
          >
            <option value="">when I ask</option>
            {SCHEDULE_HOURS.map((hours) => (
              <option key={hours} value={String(hours)}>
                every {hoursText(hours)}
              </option>
            ))}
          </select>
        </div>
        <Button
          size="xs"
          className="ms-auto"
          data-testid="memory-update-now"
          disabled={busy || starting}
          title={busy ? "One run per workspace at a time" : undefined}
          onClick={updateNow}
        >
          Update now
        </Button>
      </div>
      <p data-testid="memory-update-mode-note" className="text-meta text-description">
        {MODE_TEXT[mode].note} An update reads what happened since the last one: workers' reports,
        merges, answered questions and each finished thread's recap, never whole transcripts.
        {every === undefined
          ? ""
          : ` It runs every ${hoursText(every)} when something happened since the last.`}
      </p>
      <InlineConfirm
        open={confirmAuto}
        label="Switch memory updates to Auto?"
        confirmLabel="Switch to Auto"
        busy={saving}
        onCancel={() => setConfirmAuto(false)}
        onConfirm={() => {
          setConfirmAuto(false);
          save({ memoryUpdateMode: "auto" });
        }}
      >
        {waiting.length === 1
          ? "The draft waiting for your review is discarded."
          : `The ${waiting.length} drafts waiting for your review are discarded.`}{" "}
        What they read is read again by the next update, which applies itself. Memory and its
        History stay as they are.
      </InlineConfirm>
      {last !== undefined && (
        <div data-testid="memory-update-last" className="flex flex-col gap-1 text-meta">
          <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
            <span className="text-foreground">Last update</span>
            <span>{agoText(last.endedAt ?? last.createdAt, now)}</span>
            <span>· {last.mode === "auto" ? "Auto" : "Review"}</span>
            {last.adoptedVersion !== undefined && (
              <span>
                · version <span className="font-mono">{last.adoptedVersion}</span>
              </span>
            )}
            {last.revertedAt !== undefined && <span>· reverted</span>}
            {dreamWaitsForReview(last) && <span>· waits for your review</span>}
          </p>
          {last.summary !== undefined && (
            <p data-testid="memory-update-summary" className="text-reading">
              {last.summary}
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-0.5">
            <Button
              size="xs"
              variant="outline"
              data-testid="memory-update-see"
              onClick={() => onSeeChanges(last.id)}
            >
              See changes
            </Button>
            {revertable(last, current) && (
              <Button
                size="xs"
                variant="outline"
                data-testid="memory-update-revert"
                disabled={reverting}
                onClick={() => revert(last)}
              >
                Revert
              </Button>
            )}
          </div>
        </div>
      )}
      {reverted && (
        <p
          role="status"
          data-testid="memory-update-reverted"
          className="text-meta text-description"
        >
          Reverted: what the update changed is put back as a new version, and notes written since
          are kept. History has both.
        </p>
      )}
      {error !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
