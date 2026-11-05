import type { OrchestratorLedger, ThreadSummary, WorkspaceId } from "@gram/contracts";

import { foldedSummaryText, stateWord } from "@/orchestration/overview-model";
import { glyphState, workerStatusWord } from "@/orchestration/status-words";
import { workingWorkerThreads } from "@/orchestration/tree-model";
import { workersByTab, workerTones, type WorkerLiveFacts } from "@/orchestration/workers-model";
import { threadStatusOf } from "@/sidebar/status";

// What the palette says of each thread's status: the words the sidebar, the Board and ⌘J say of
// it, from the same selectors, so an item never reads "Stopped" here and "Waiting · checks" there.
// No React.

/** A workspace as the palette lists its threads. */
export interface PaletteWorkspace {
  readonly id: WorkspaceId;
  readonly paused: boolean;
}

/** Words for a sentence's start: "paused" as a line's first word. */
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Each workspace's workers and orchestrator, by thread, in words: a worker by its row in ⌘J (its
 * tone's word, or what it waits on), an orchestrator by its line in the sidebar (paused, its
 * workers' count, else its own status). A thread it leaves out says its own status (`statusWord`).
 */
export const paletteStatusWords = (
  workspaces: readonly PaletteWorkspace[],
  ledgers: ReadonlyMap<WorkspaceId, Pick<OrchestratorLedger, "features">>,
  facts: WorkerLiveFacts,
): ReadonlyMap<string, string> => {
  const words = new Map<string, string>();
  for (const workspace of workspaces) {
    const ledger = ledgers.get(workspace.id);
    const tabs = workersByTab(ledger, facts);
    for (const feature of [...tabs.now, ...tabs.done]) {
      for (const row of feature.rows) {
        words.set(row.threadId, workerStatusWord(glyphState(row.glyph), row.waiting));
      }
    }
    const running = workingWorkerThreads(facts.byId, facts.statusDetail, workspace.id).map(
      (summary) => summary.thread.id,
    );
    const { live, working } = workerTones(ledger, running, facts);
    for (const summary of Object.values(facts.byId)) {
      if (summary === undefined) continue;
      const { thread } = summary;
      if (thread.role !== "orchestrator" || thread.workspaceId !== workspace.id) continue;
      const own = threadStatusOf(summary, facts.statusDetail[thread.id]);
      words.set(
        thread.id,
        own.working
          ? own.label
          : workspace.paused
            ? capitalized(stateWord("paused"))
            : live > 0
              ? capitalized(foldedSummaryText({ live, working, asks: 0 }))
              : own.label,
      );
    }
  }
  return words;
};

/** A thread's status in the palette: its workspace's words for it, else its own. */
export const statusWord = (summary: ThreadSummary, words: ReadonlyMap<string, string>): string =>
  words.get(summary.thread.id) ?? threadStatusOf(summary).label;
