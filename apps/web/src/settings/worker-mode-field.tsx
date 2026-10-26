import type { PermissionMode } from "@gram/contracts";
import { useId } from "react";

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
    <fieldset data-testid={testId} data-value={checked} className="flex flex-col gap-1.5">
      <legend className="mb-1.5 font-medium">Worker mode</legend>
      {choices.map((choice, i) => (
        <label key={choice.value} className="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            name={name}
            className="mt-0.5 size-4 accent-primary"
            {...(autofocus && i === 0 ? { "data-autofocus": true } : {})}
            checked={checked === choice.value}
            disabled={disabled}
            onChange={() => onChange(choice.value)}
          />
          <span className="flex min-w-0 flex-col">
            <span>{choice.label}</span>
            <span className="text-xs text-muted-foreground">{choice.line}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
