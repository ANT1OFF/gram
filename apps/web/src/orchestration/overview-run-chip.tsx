import { Workflow } from "lucide-react";
import type { MouseEvent } from "react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import { Hint } from "@/components/hint";
import { PrMarkIcon } from "@/components/pr-marks";
import { checksMarkOf } from "@/components/pr-marks-model";
import { cn } from "@/lib/utils";

import { runChipOf, type RunChip, type WatchedRun } from "./overview-run-chip-model";

// The workflow runs a worker watches (`run_monitor`), as one chip beside its PR chips: the run
// glyph, a count when it watches more than one, and the running mark CI's pending checks have. Its
// words, each run's name and that it is watched, are its hover; a click opens the run on GitHub.

/** A run is watched only while it runs (`runReason`), so its mark is CI's pending ring. */
const RUNNING = checksMarkOf("pending");

/** The chip's box: a PR chip's plain one, 16 px tall on a row's status line or 20 px elsewhere. */
const chipClass = (dense: boolean) =>
  cn(
    "inline-flex cursor-default items-center gap-1 rounded-(--radius-sm) bg-sidebar-row-hover px-1.5 text-meta text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
    dense ? "h-4" : "h-5",
  );

function RunChipFace({ chip }: { chip: RunChip }) {
  return (
    <>
      <Workflow aria-hidden className="size-icon-chip shrink-0" />
      {chip.count > 1 && <span className="font-mono text-meta tabular-nums">{chip.count}</span>}
      <PrMarkIcon group="checks" mark={RUNNING} data-run-status="running" />
    </>
  );
}

/**
 * `ghost` draws it unseen and inert, holding its room in a row's button while the real one sits
 * over it (`WorkerPrChips`).
 */
export function WorkerRunChip({
  runs,
  dense = false,
  ghost = false,
}: {
  runs: readonly WatchedRun[];
  dense?: boolean;
  ghost?: boolean;
}) {
  const api = useApi();
  const chip = runChipOf(runs);
  if (chip === undefined) return null;
  if (ghost) {
    return (
      <span className={chipClass(dense)}>
        <RunChipFace chip={chip} />
      </span>
    );
  }
  const open = (event: MouseEvent) => {
    event.preventDefault();
    void openExternalUrl(api, chip.url);
  };
  return (
    <Hint
      label={chip.hint}
      delay={250}
      side="right"
      render={
        <button
          type="button"
          data-testid="overview-run-chip"
          data-runs={chip.count}
          aria-label={chip.label}
          onClick={open}
          className={chipClass(dense)}
        />
      }
    >
      <RunChipFace chip={chip} />
    </Hint>
  );
}
