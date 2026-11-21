import type { OrchestratorCharter } from "@gram/contracts";
import { lazy, Suspense, useState } from "react";

import { FOLD, FoldSummary } from "@/components/fold-summary";
import { useModelNames } from "@/composer/models";
import { Spinner } from "@/motion";
import { useDefaultModel, useRosterHere, useSlotModel } from "@/settings/model-slots";
import { defaultWorkerIndex } from "@/settings/workspace-settings-model";

const RosterEditor = lazy(() =>
  import("@/settings/roster-editor").then((module) => ({ default: module.RosterEditor })),
);

/** New workspace's Models: the orchestrator's and default worker's models, folded, with the roster editor inside. */
export function WorkspaceModels({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter) => void;
}) {
  const [opened, setOpened] = useState(false);
  const own = useSlotModel(charter.orchestratorModel);
  const inherited = useDefaultModel();
  const orchestrator = charter.orchestratorModel === undefined ? inherited : own;
  const workers = charter.workerModels ?? [];
  const roster = useRosterHere(workers);
  const defaultIndex = defaultWorkerIndex(workers);
  const picked = defaultIndex === undefined ? undefined : roster[defaultIndex];
  const worker =
    picked === undefined ? orchestrator : picked.missing === undefined ? picked.entry : undefined;
  const nameOf = useModelNames([orchestrator, worker]);

  return (
    <details
      className={FOLD}
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <FoldSummary className="items-baseline text-reading">
        <span className="font-medium">Models</span>
        {(orchestrator || worker) && (
          <span className="flex flex-wrap gap-x-4 text-meta text-description">
            {orchestrator && <span>Orchestrator · {nameOf(orchestrator)}</span>}
            {worker && <span>Default worker · {nameOf(worker)}</span>}
          </span>
        )}
      </FoldSummary>
      {opened && (
        <div className="mt-3 flex flex-col gap-4">
          <Suspense
            fallback={<Spinner aria-label="Loading model settings" className="size-icon-row" />}
          >
            <RosterEditor
              charter={charter}
              disabled={disabled}
              onChange={onChange}
              orchestratorDescription="Used for the repository survey and the first task."
            />
          </Suspense>
        </div>
      )}
    </details>
  );
}
