import type { PermissionMode } from "@gram/contracts";
import { useId } from "react";

import { RadioGroup } from "@/components/ui/checkbox";

import {
  FOLLOW_DEFAULT_CHOICE,
  FOLLOW_DEFAULT_MODE,
  WORKER_MODE_CHOICES,
  type WorkerModeChoice,
} from "./workspace-settings-model";

/**
 * The permission mode workers start in, each choice said in one line: the wizard's step and a
 * workspace's settings show the same control. "Follow the default" is offered only to a workspace
 * that still has no mode of its own, which one made before modes did.
 */
export function WorkerModeField({
  value,
  disabled = false,
  autofocus = false,
  testId = "worker-mode",
  onChange,
}: {
  value: PermissionMode | undefined;
  disabled?: boolean;
  /** Marks the first choice for the wizard's step to focus. */
  autofocus?: boolean;
  testId?: string;
  onChange: (mode: WorkerModeChoice) => void;
}) {
  const name = useId();
  const choices =
    value === undefined ? [FOLLOW_DEFAULT_CHOICE, ...WORKER_MODE_CHOICES] : WORKER_MODE_CHOICES;
  const checked: WorkerModeChoice = value ?? FOLLOW_DEFAULT_MODE;
  return (
    // A radiogroup named by its own line, not a fieldset: a legend sits on the fieldset's top
    // edge, so in a card of rows the hairline between rows ran through the name.
    <div data-testid={testId} data-value={checked} className="flex flex-col gap-1.5">
      <div id={`${name}-label`} className="font-medium">
        Worker mode
      </div>
      <RadioGroup<WorkerModeChoice>
        labelledBy={`${name}-label`}
        name={name}
        options={choices.map((choice) => ({
          value: choice.value,
          label: choice.label,
          description: choice.line,
        }))}
        value={checked}
        onChange={onChange}
        disabled={disabled}
        autoFocusFirst={autofocus}
      />
    </div>
  );
}
