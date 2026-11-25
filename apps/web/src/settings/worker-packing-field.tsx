import {
  embeddingOn,
  type OrchestratorCharter,
  type WorkerPackingDefault,
  workerPackingOf,
} from "@gram/contracts";

import { useServerSettings } from "@/settings-sync/store";

import { OptionGroup, SettingRow } from "./fields";
import { withWorkerPacking, withWorkersPerMachine } from "./workspace-settings-model";

const PACKING_CHOICES: ReadonlyArray<{ value: WorkerPackingDefault; label: string }> = [
  { value: "orchestrator", label: "Its machine" },
  { value: "shared", label: "Shared" },
  { value: "own", label: "One each" },
];

const PACKING_SAVED: Readonly<Record<WorkerPackingDefault, string>> = {
  orchestrator: "Workers run on the orchestrator's machine",
  shared: "Workers share hosted machines",
  own: "Each worker gets a hosted machine",
};

const CAP_CHOICES = [
  { value: "provider", label: "Its own" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "4", label: "4" },
  { value: "8", label: "8" },
] as const;

type CapChoice = "provider" | `${number}`;

/**
 * Per workspace: where a worker runs when the orchestrator names no machine for it, and the most
 * workers one hosted machine carries. Shown only with the hosted features on, where a worker can
 * have a hosted machine at all. Unset, nothing differs from before: a worker runs on its
 * orchestrator's machine, and a machine's own cap applies.
 */
export function WorkerPackingField({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter, title: string) => void;
}) {
  const hosted = useServerSettings((s) => s.settings !== undefined && embeddingOn(s.settings));
  if (!hosted) return null;
  const packing = workerPackingOf(charter);
  const cap = charter.workersPerMachine;
  const capValue: CapChoice = cap === undefined ? "provider" : `${cap}`;
  const capOptions = CAP_CHOICES.some((choice) => choice.value === capValue)
    ? CAP_CHOICES
    : [...CAP_CHOICES, { value: capValue, label: String(cap) }];
  return (
    <>
      <div data-testid="worker-packing" data-value={packing}>
        <SettingRow
          label="Workers run on"
          description="Where a worker runs when the orchestrator names no machine for it. Workers on one shared machine start in seconds, and can read each other's files."
          keywords={["hosted", "machine", "sandbox", "shared", "pack", "packing", "workers"]}
        >
          <OptionGroup
            label="Workers run on"
            options={PACKING_CHOICES}
            value={packing}
            disabled={disabled}
            onChange={(choice) =>
              onChange(withWorkerPacking(charter, choice), PACKING_SAVED[choice])
            }
          />
        </SettingRow>
      </div>
      <div data-testid="workers-per-machine" data-value={capValue}>
        <SettingRow
          label="Workers per machine"
          description="The most workers one hosted machine carries. It only lowers what the machine's own size allows."
          keywords={["hosted", "machine", "cap", "shared", "pack", "packing", "workers"]}
        >
          <OptionGroup
            label="Workers per machine"
            options={capOptions}
            value={capValue}
            disabled={disabled}
            onChange={(choice) =>
              onChange(
                withWorkersPerMachine(charter, choice === "provider" ? undefined : Number(choice)),
                choice === "provider"
                  ? "A machine carries what its size allows"
                  : `At most ${choice} worker${choice === "1" ? "" : "s"} on one machine`,
              )
            }
          />
        </SettingRow>
      </div>
    </>
  );
}
