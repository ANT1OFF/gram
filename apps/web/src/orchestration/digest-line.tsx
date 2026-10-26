import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatClockTime } from "@/lib/time";
import { messageText } from "@/thread/message-actions";
import { DigestDetails } from "@/thread/orchestration-cards";
import { digestTitle } from "@/thread/orchestration-model";

import { digestLineWords, type StreamDigest } from "./stream-model";

/**
 * A digest in the orchestrator's stream: one quiet line, "Digest #4 · 3 reports · 14:12", in the
 * stream's small muted type with no box, quieter than the event lines and the live cards. It
 * starts collapsed and only a click, Enter or Space opens it in place, on what the digest said:
 * why it woke the orchestrator, the workers' reports (as plain text), the ledger and the text the
 * agent was sent. Digests with nothing between them share one line.
 */
export function DigestLine({ digests }: { digests: readonly StreamDigest[] }) {
  const [open, setOpen] = useState(false);
  const words = digestLineWords(digests);
  const said = [words.title, words.count].filter((word) => word !== undefined);
  const folded = digests.length > 1;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="digest-line"
      data-count={digests.length}
      className="max-w-2xl"
    >
      <CollapsibleTrigger
        data-testid="digest-line-toggle"
        aria-label={[...said, words.time].filter((word) => word !== undefined).join(", ")}
        className="group flex w-full min-w-0 items-center gap-1.5 rounded-sm py-0.5 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className="size-3 shrink-0 opacity-60 transition-transform group-hover:opacity-100 group-data-[panel-open]:rotate-90"
        />
        <span className="min-w-0 truncate">{said.join(" · ")}</span>
        {words.time !== undefined && (
          <span className="ml-auto shrink-0 tabular-nums">{words.time}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="gram-collapse">
        <div data-testid="digest-line-details" className="flex flex-col gap-4 py-1.5 pl-4.5">
          {digests.map(({ message, digest, at }) => {
            const title = digestTitle(digest);
            return (
              <section
                key={message.id}
                aria-label={title}
                data-variant={digest.variant}
                className="flex flex-col gap-2.5 text-sm"
              >
                {folded && (
                  <h3 className="flex items-baseline gap-2 text-xs font-medium">
                    {title}
                    {at !== undefined && (
                      <span className="font-normal text-muted-foreground tabular-nums">
                        {formatClockTime(at)}
                      </span>
                    )}
                  </h3>
                )}
                <DigestDetails digest={digest} text={messageText(message)} />
              </section>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
