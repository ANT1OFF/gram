import { BrainIcon } from "lucide-react";

import { Shimmer } from "@/components/ai-elements/shimmer";
import { ExpandPresence } from "@/motion";

/**
 * The line that says the model is thinking. It exists only while the reasoning part streams, and
 * folds away as it ends rather than vanishing under the reader: a finished one leaves nothing in
 * the transcript, since most models don't return the text anyway.
 */
export function ReasoningBlock({ isStreaming }: { isStreaming: boolean }) {
  return (
    <ExpandPresence open={isStreaming}>
      <div
        data-testid="reasoning-note"
        role="status"
        className="not-prose flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <BrainIcon aria-hidden className="size-3.5" />
        <Shimmer duration={1}>Thinking…</Shimmer>
      </div>
    </ExpandPresence>
  );
}
