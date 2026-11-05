import {
  routineScheduleText,
  type OrchestratorCharter,
  type WorkspaceRoutine,
} from "@gram/contracts";

import { Button } from "@/components/ui/button";

import { Toggle } from "./fields";

/** The charter with `routines` set, or without the key when none is left. */
export const withRoutines = (
  charter: OrchestratorCharter,
  routines: ReadonlyArray<WorkspaceRoutine>,
): OrchestratorCharter => {
  const { routines: _, ...rest } = charter;
  return routines.length === 0 ? rest : { ...rest, routines };
};

/**
 * The workspace's routines: each one's schedule and brief, a switch to keep it without running it,
 * and Remove. New ones are asked of the orchestrator, which proposes them on an approval card.
 */
export function RoutinesField({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter, title: string) => void;
}) {
  const routines = charter.routines ?? [];
  if (routines.length === 0) {
    return (
      <p data-testid="routines-empty" className="text-meta text-muted-foreground">
        None yet. Ask the orchestrator for one, such as “every weekday at 09:00, triage main’s CI”,
        and approve the card it shows you.
      </p>
    );
  }
  return (
    <ul data-testid="routines" className="flex flex-col gap-3">
      {routines.map((routine, index) => {
        const on = routine.off !== true;
        const replace = (next: WorkspaceRoutine | undefined) =>
          routines.flatMap((each, n) => (n !== index ? [each] : next === undefined ? [] : [next]));
        return (
          <li key={routine.name} className="flex flex-col gap-1">
            <Toggle
              label={routine.name}
              description={`Starts a worker ${routineScheduleText(routine.schedule)}.`}
              keywords={["routine", "schedule", "recurring", "cron"]}
              checked={on}
              disabled={disabled}
              detail={
                <div className="flex flex-col gap-1">
                  <p className="text-meta whitespace-pre-wrap text-muted-foreground">
                    {routine.brief}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-fit"
                    disabled={disabled}
                    onClick={() =>
                      onChange(
                        withRoutines(charter, replace(undefined)),
                        `Routine “${routine.name}” removed`,
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              }
              onChange={(next) => {
                const { off: _, ...rest } = routine;
                onChange(
                  withRoutines(charter, replace(next ? rest : { ...rest, off: true })),
                  next ? `Routine “${routine.name}” on` : `Routine “${routine.name}” off`,
                );
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}
