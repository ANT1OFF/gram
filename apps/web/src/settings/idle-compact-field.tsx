import { idleCompactOf, type IdleCompactKind, type OrchestratorCharter } from "@gram/contracts";

import { Toggle } from "./fields";

/** Where Settings scrolls to from a compaction marker's link. */
export const IDLE_COMPACT_ANCHOR = "idle-compact";

/** The charter with idle compaction on or off; on is the default, so it leaves the key out. */
export const withIdleCompact = (
  charter: OrchestratorCharter,
  enabled: boolean,
): OrchestratorCharter => {
  const { idleAutoCompact: _, ...rest } = charter;
  return enabled ? rest : { ...rest, idleAutoCompact: false };
};

/** The charter with workers covered or not; the orchestrator alone is the default. */
export const withIdleCompactWorkers = (
  charter: OrchestratorCharter,
  workers: boolean,
): OrchestratorCharter => {
  const { idleAutoCompactKinds: _, ...rest } = charter;
  const kinds: IdleCompactKind[] = ["orchestrator", "worker"];
  return workers ? { ...rest, idleAutoCompactKinds: kinds } : rest;
};

/**
 * Per workspace: compact a large idle Claude thread just before its prompt cache expires, so its
 * next wake starts from a summary rather than rewriting the whole conversation. On by default for
 * the orchestrator; workers when the user adds them.
 */
export function IdleCompactField({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter, title: string) => void;
}) {
  const { enabled, kinds } = idleCompactOf(charter);
  const workers = kinds.includes("worker");
  return (
    <>
      <div id={IDLE_COMPACT_ANCHOR} data-testid="idle-compact" data-enabled={enabled}>
        <Toggle
          label="Compact idle threads"
          description="Shrink an idle Claude thread before its prompt cache expires."
          keywords={["compact", "compaction", "cache", "idle", "context", "tokens"]}
          checked={enabled}
          disabled={disabled}
          onChange={(next) =>
            onChange(
              withIdleCompact(charter, next),
              next
                ? "Idle threads are compacted before their cache expires"
                : "Idle compaction off",
            )
          }
          learnMore={
            <>
              <p>
                A thread over 150K tokens left idle is compacted 55 minutes after its last request,
                never while you have a draft for it.
              </p>
              <p>
                The agent then carries on from its own summary of the conversation, so details the
                summary leaves out are gone for it; the transcript keeps everything, and a marker
                says when it happened.
              </p>
            </>
          }
        />
      </div>
      <div data-testid="idle-compact-workers">
        <Toggle
          label="Compact idle workers too"
          description="Off, only the orchestrator's own thread is compacted."
          keywords={["compact", "workers"]}
          checked={workers}
          disabled={disabled || !enabled}
          disabledReason="Idle compaction is off for this workspace."
          onChange={(next) =>
            onChange(
              withIdleCompactWorkers(charter, next),
              next
                ? "Idle compaction covers workers"
                : "Idle compaction covers the orchestrator only",
            )
          }
        />
      </div>
    </>
  );
}
