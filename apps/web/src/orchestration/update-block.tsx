import { ChevronRight, History } from "lucide-react";
import { useId, useState } from "react";

import { PR_STATE_DISPLAY } from "@/components/pr-marks-model";
import { cn } from "@/lib/utils";
import { Expand } from "@/motion";

import { DigestLine } from "./digest-line";
import { StreamLineView } from "./feature-card";
import { updateWords, type StreamDigest, type TimedLine } from "./stream-model";

/**
 * A count's tone, as its lines are toned: amber only for what needs the user (#121), red for a
 * failure, the merged colour for merges.
 */
const COUNT_TONE: Record<string, string> = {
  ask: "text-status-needs",
  failed: "text-destructive",
  merged: PR_STATE_DISPLAY.merged.tone,
};

/**
 * The background events a run of digests brought, as one update in the orchestrator's stream: a
 * single header line, "2 merged · 1 report · 09:19", in a quiet box that sets it apart from the
 * orchestrator's prose. It opens in place on every line it gathered and on the digests behind
 * them, so nothing is hidden, only folded; an update with a line that needs the user or failed
 * starts open. A run that spoke no line is its digest line alone, in the same box.
 */
export function UpdateBlock({
  lines,
  digests,
}: {
  lines: readonly TimedLine[];
  digests: readonly StreamDigest[];
}) {
  const words = updateWords(lines, digests);
  const [toggled, setToggled] = useState<boolean>();
  const open = toggled ?? words.needsYou;
  const [everOpened, setOpened] = useState(false);
  const opened = everOpened || open;
  const bodyId = useId();
  const box = "w-full rounded-(--radius-md) border border-border/70 bg-muted/20 px-2.5 py-1";
  if (lines.length === 0) {
    return digests.length === 0 ? null : (
      <div data-testid="update-block" data-lines={0} className={box}>
        <DigestLine digests={digests} />
      </div>
    );
  }
  const said = words.counts.map((count) => count.text);
  if (words.digest.count !== undefined) said.push(words.digest.count);
  return (
    <div
      data-testid="update-block"
      data-lines={lines.length}
      data-open={open}
      className={cn(
        box,
        words.counts.some((count) => count.kind === "ask") && "border-status-needs-mark/40",
      )}
    >
      <button
        type="button"
        data-testid="update-block-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={["Update", ...said, words.time].filter((word) => word !== undefined).join(", ")}
        className="group flex w-full min-w-0 items-center gap-1.5 rounded-sm py-0.5 text-left text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          setToggled(!open);
          setOpened(true);
        }}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground opacity-60 transition-transform duration-(--dur-fast) group-hover:opacity-100",
            open && "rotate-90",
          )}
        />
        <History aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">
          <span className="font-medium text-foreground">Update</span>
          {words.counts.map((count) => (
            <span key={count.kind}>
              <span className="text-muted-foreground"> · </span>
              <span className={COUNT_TONE[count.kind] ?? "text-foreground"}>{count.text}</span>
            </span>
          ))}
          {words.digest.count !== undefined && (
            <span className="text-muted-foreground"> · {words.digest.count}</span>
          )}
        </span>
        {words.time !== undefined && (
          <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{words.time}</span>
        )}
      </button>
      <Expand open={open} id={bodyId}>
        {opened && (
          <div data-testid="update-block-body" className="flex flex-col pt-0.5 pb-1 pl-5">
            {lines.map(({ line, at }, index) => (
              <StreamLineView key={`${line.key}:${index}`} line={line} at={at} />
            ))}
            <DigestLine digests={digests} />
          </div>
        )}
      </Expand>
    </div>
  );
}
