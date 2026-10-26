import { WORKER_BRIEF_FOOTER_MAX, type OrchestratorCharter } from "@gram/contracts";
import { useId, useState } from "react";

import { cn } from "@/lib/utils";

import { Field, inputCls } from "./fields";
import { withWorkerBriefFooter } from "./workspace-settings-model";

/**
 * The workspace's standing instructions for its workers, which Gram appends to every worker brief.
 * Kept as a draft while typed and saved when the field is left, so it isn't a charter write per
 * keystroke. Empty, nothing is appended.
 */
export function WorkerBriefFooterField({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter, title: string) => void;
}) {
  const id = useId();
  const saved = charter.workerBriefFooter ?? "";
  const [draft, setDraft] = useState(saved);
  const [was, setWas] = useState(saved);
  // A footer saved elsewhere, by chat or a refused save, replaces a draft nobody is typing.
  if (saved !== was) {
    setWas(saved);
    setDraft(saved);
  }
  const commit = () => {
    if (draft.trim() === saved.trim()) return;
    onChange(
      withWorkerBriefFooter(charter, draft),
      draft.trim() === "" ? "Worker brief footer removed" : "Worker brief footer saved",
    );
  };
  return (
    <div data-testid="worker-brief-footer">
      <Field
        label="Worker brief footer"
        description="Your standing instructions, added to the end of every worker brief in this workspace."
        htmlFor={id}
        keywords={["brief", "footer", "standing instructions", "rules", "workers"]}
        learnMore={
          <p>
            Each worker sees it marked as this workspace's standing instructions, and the
            orchestrator is told it is there, so it doesn't repeat it in briefs. Empty adds nothing.
          </p>
        }
      >
        <textarea
          id={id}
          data-testid="worker-brief-footer-input"
          className={cn(inputCls, "h-auto min-h-16 max-w-none resize-y py-1.5 leading-snug")}
          rows={3}
          maxLength={WORKER_BRIEF_FOOTER_MAX}
          placeholder="None"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(saved);
          }}
        />
      </Field>
    </div>
  );
}
