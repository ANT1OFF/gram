import { Copy } from "lucide-react";

import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { useFlash } from "@/lib/timers";
import { DrawnCheck, Swap } from "@/motion";
import { copyText } from "@/settings/copy-text";
import { useThreadsStore } from "@/stores/threads";

/** How long "Copied" stays before the button reads "Copy" again. */
export const COPIED_MS = 1500;

/** Copies `text`, telling the user in a toast when there's no button to show a checkmark. */
export async function copyMarkdown(text: string, options: { toast?: boolean } = {}) {
  try {
    await copyText(text);
    if (options.toast) {
      useThreadsStore.getState().applyEvent({ type: "notify", kind: "info", title: "Copied" });
    }
    return true;
  } catch (error) {
    useThreadsStore.getState().applyEvent({
      type: "notify",
      kind: "error",
      title: "Couldn't copy",
      body: errorMessage(error),
    });
    return false;
  }
}

/** Copies a task's whole command, which the line and its tooltip show only the start of. */
export function CopyButton({ command, testId }: { command: string; testId: string }) {
  const [copied = false, flash] = useFlash(COPIED_MS);
  const label = copied ? "Copied" : "Copy command";
  return (
    <Hint
      label={label}
      render={
        <button
          type="button"
          data-testid={testId}
          aria-label={label}
          onClick={() => {
            void copyMarkdown(command).then((ok) => ok && flash(true));
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      }
    >
      <Swap swapKey={copied ? "copied" : "copy"}>
        {copied ? (
          <DrawnCheck className="size-icon-chip text-success" />
        ) : (
          <Copy aria-hidden className="size-icon-row" />
        )}
      </Swap>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </Hint>
  );
}
