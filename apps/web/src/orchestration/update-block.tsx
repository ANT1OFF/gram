import type { GramUIMessage } from "@gram/contracts";
import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { PR_STATE_DISPLAY } from "@/components/pr-marks-model";
import { formatStamp } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Expand } from "@/motion";

import { DigestLine } from "./digest-line";
import { StreamLineView } from "./feature-card";
import { replyPreview, updateWords, type StreamDigest, type TimedLine } from "./stream-model";

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
 * single light line, "09:19 · Update · 2 merged · 1 report · More", its time first, muted and with
 * no box, no rule and no glyph but its fold's chevron (History's clock means History): the space
 * round it, a reply's 12 px block step, sets it apart, so it reads as a marker between the
 * orchestrator's answers rather than one of them. It opens in place on every line it gathered and on the digests behind
 * them, so nothing is hidden, only folded; an update with a line that needs the user or failed
 * starts open. A run that spoke no line is its digest line alone, in the same box.
 *
 * In the quiet stream an update also folds the orchestrator's replies to digests that changed
 * nothing for the user (`replies`): its one line then reads how many digests it holds and the
 * newest reply's first words, "Update · 5 digests · The release build is 23 minutes in… 18:10",
 * and it opens on every reply, drawn by `renderReply` as the transcript draws a message.
 */
export function UpdateBlock({
  lines,
  digests,
  replies,
  renderReply,
}: {
  lines: readonly TimedLine[];
  digests: readonly StreamDigest[];
  replies?: readonly GramUIMessage[] | undefined;
  renderReply?: ((reply: GramUIMessage) => ReactNode) | undefined;
}) {
  const words = updateWords(lines, digests);
  const quiet = replies !== undefined && replies.length > 0;
  const [toggled, setToggled] = useState<boolean>();
  const open = toggled ?? words.needsYou;
  const [everOpened, setOpened] = useState(false);
  const opened = everOpened || open;
  const bodyId = useId();
  // A line, not a card: the answers around it carry the weight.
  const box = "w-full py-1";
  if (quiet) {
    return (
      <QuietUpdate lines={lines} digests={digests} replies={replies} renderReply={renderReply} />
    );
  }
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
    <div data-testid="update-block" data-lines={lines.length} data-open={open} className={box}>
      <button
        type="button"
        data-testid="update-block-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={["Update", ...said, words.time].filter((word) => word !== undefined).join(", ")}
        className="group flex w-full min-w-0 items-center gap-1.5 rounded-sm py-0.5 text-left text-meta outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          setToggled(!open);
          setOpened(true);
        }}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-icon-chip shrink-0 text-muted-foreground transition-transform duration-(--dur-fast) group-hover:text-foreground",
            open && "rotate-90",
          )}
        />
        <UpdateTime time={words.time} />
        <span className="min-w-0 truncate text-muted-foreground">
          <span className="font-medium">Update</span>
          {words.counts.map((count) => (
            <span key={count.kind}>
              {" · "}
              <span className={COUNT_TONE[count.kind]}>{count.text}</span>
            </span>
          ))}
          {words.digest.count !== undefined && <span> · {words.digest.count}</span>}
        </span>
        <FoldWord open={open} />
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

/**
 * A quiet update: digests, their lines and the orchestrator's replies that changed nothing for the
 * user, as one line that updates in place. It starts closed; open, it shows every line, every reply
 * and the digests behind them, so nothing it folds is out of reach.
 */
function QuietUpdate({
  lines,
  digests,
  replies,
  renderReply,
}: {
  lines: readonly TimedLine[];
  digests: readonly StreamDigest[];
  replies: readonly GramUIMessage[];
  renderReply?: ((reply: GramUIMessage) => ReactNode) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [everOpened, setOpened] = useState(false);
  const bodyId = useId();
  const words = updateWords(lines, digests);
  const preview = replyPreview(replies);
  const newest = Math.max(
    ...digests.flatMap(({ at }) => (at === undefined ? [] : [at])),
    ...replies.flatMap((reply) => reply.metadata?.createdAt ?? []),
  );
  const time = Number.isFinite(newest) ? formatStamp(newest) : words.time;
  const many = digests.length > 1 ? `${digests.length} digests` : undefined;
  const said = [...words.counts.map((count) => count.text), many, preview];
  return (
    <div
      data-testid="update-block"
      data-quiet="true"
      data-lines={lines.length}
      data-digests={digests.length}
      data-replies={replies.length}
      data-open={open}
      className="w-full py-1"
    >
      <button
        type="button"
        data-testid="update-block-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={["Update", ...said, time].filter((word) => word !== undefined).join(", ")}
        className="group flex w-full min-w-0 items-center gap-1.5 rounded-sm py-0.5 text-left text-meta outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          setOpen(!open);
          setOpened(true);
        }}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-icon-chip shrink-0 text-muted-foreground transition-transform duration-(--dur-fast) group-hover:text-foreground",
            open && "rotate-90",
          )}
        />
        <UpdateTime time={time} />
        <span className="min-w-0 truncate text-muted-foreground">
          <span className="font-medium">Update</span>
          {words.counts.map((count) => (
            <span key={count.kind}>
              {" · "}
              <span className={COUNT_TONE[count.kind]}>{count.text}</span>
            </span>
          ))}
          {many !== undefined && <span> · {many}</span>}
          {preview !== undefined && (
            <span data-testid="update-block-preview">
              {" · "}
              {preview}
            </span>
          )}
        </span>
        <FoldWord open={open} />
      </button>
      <Expand open={open} id={bodyId}>
        {(everOpened || open) && (
          <div data-testid="update-block-body" className="flex flex-col gap-1 pt-0.5 pb-1 pl-5">
            {lines.map(({ line, at }, index) => (
              <StreamLineView key={`${line.key}:${index}`} line={line} at={at} />
            ))}
            {renderReply !== undefined &&
              replies.map((reply) => (
                <div key={reply.id} data-testid="update-block-reply" className="text-reading">
                  {renderReply(reply)}
                </div>
              ))}
            <DigestLine digests={digests} />
          </div>
        )}
      </Expand>
    </div>
  );
}

/** An update's time, first on its line, as the stream's other markers put it. */
function UpdateTime({ time }: { time: string | undefined }) {
  if (time === undefined) return null;
  return (
    <span data-testid="update-block-time" className="shrink-0 text-muted-foreground tabular-nums">
      {time}
    </span>
  );
}

/**
 * What the line does, in words, after what it says: a cut preview ends in "…", so the fold says
 * "More" rather than leaving the chevron alone to tell it opens. The toggle's name already says it.
 */
function FoldWord({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      data-testid="update-block-fold"
      className="shrink-0 font-medium text-muted-foreground group-hover:text-foreground"
    >
      {open ? "Less" : "More"}
    </span>
  );
}
