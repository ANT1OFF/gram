import type { FinishedWorker, ThreadId } from "@gram/contracts";

import { focusPaneComposer } from "@/shell/pane-focus";
import { useDraftStore } from "@/stores/drafts";
import { useLayoutStore } from "@/stores/layout";

// "Ask about it": a message to the orchestrator about one worker, started in its composer with the
// worker's context and left there for the user to finish and send. Nothing is sent from here.

/** `text` appended to the orchestrator's draft, which then opens with its composer focused. */
export function startOrchestratorMessage(
  orchestrator: ThreadId,
  text: string,
  open: (threadId: ThreadId) => void,
): void {
  const drafts = useDraftStore.getState();
  const current = drafts.text[orchestrator] ?? "";
  drafts.setText(orchestrator, current.trim() === "" ? text : `${current.trimEnd()}\n\n${text}`);
  open(orchestrator);
  focusPaneComposer(useLayoutStore.getState().grid.focused, { always: true });
  requestAnimationFrame(() => {
    const composer = document.activeElement;
    if (composer instanceof HTMLTextAreaElement) {
      composer.setSelectionRange(composer.value.length, composer.value.length);
    }
  });
}

const quoted = (text: string, max = 240) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

/**
 * The opening of a message about a finished worker: which one, by the `[thread <id>]` reference
 * the orchestrator knows workers by, its feature and PRs, and what it last reported.
 */
export const aboutFinishedWorker = (worker: FinishedWorker): string => {
  const prs = worker.prs.map((pr) => `${pr.repo}#${pr.number}`);
  const merged = worker.prs.some((pr) => pr.merged === true);
  const where = [
    `in ${worker.feature}`,
    ...(prs.length === 0 ? [] : [`${merged ? "merged as" : "with"} ${prs.join(", ")}`]),
  ].join(", ");
  const report =
    worker.lastReport === undefined
      ? ""
      : ` Its last report: "${quoted(worker.lastReport.summary)}"`;
  return `About the finished worker "${worker.title}" [thread ${worker.threadId}] ${where}.${report}\n\n`;
};
