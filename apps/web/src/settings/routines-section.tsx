import {
  ROUTINE_BRIEF_MAX,
  ROUTINE_DAYS,
  ROUTINE_MAX_INTERVAL_HOURS,
  ROUTINE_MIN_INTERVAL_HOURS,
  ROUTINE_NAME_MAX,
  routineScheduleText,
  type OrchestratorCharter,
  type Project,
  type RoutineState,
  type RoutineStatus,
  type WorkspaceRoutine,
  type WorkspaceState,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { goToThread } from "@/orchestration/worker-banner";

import { inputCls, OptionGroup } from "./fields";
import { RowMenuButton, type RowAction } from "./row-menu";
import {
  emptyRoutineForm,
  EVERY_OPTIONS,
  formOfRoutine,
  lastRunText,
  modelLabel,
  nextRunText,
  routineOfForm,
  withRoutines,
  type RoutineForm,
} from "./routines-model";
import { SettingsGroup } from "./settings-group";
import type { useWorkspaceChanges } from "./workspace-actions";
import { projectNameOf } from "./workspace-settings-model";

type Changes = ReturnType<typeof useWorkspaceChanges>;

const LABEL = "text-meta font-medium text-foreground";

/** No runs yet: a routine just saved, before the server has reckoned its next run. */
const NO_STATE: RoutineState = {};

/**
 * Workspace settings → Routines: the briefs the workspace's charter runs on a schedule, each with a
 * switch, Run now, its last and next run, and Edit and Remove in its menu. Every change is a charter
 * save, said with Undo like the page's others. Add routine opens the same form a row's Edit does.
 */
export function RoutinesSection({
  state,
  projects,
  changes,
}: {
  state: WorkspaceState;
  projects: readonly Project[];
  changes: Changes;
}) {
  const api = useApi();
  const workspaceId = state.workspace.id;
  const charter = changes.charter ?? state.charter;
  const routines = charter.routines ?? [];
  const { data: statuses = [] } = useQuery({
    queryKey: ["routines", workspaceId],
    queryFn: () => api.listRoutines(workspaceId),
  });
  const [adding, setAdding] = useState(false);
  const save = (next: OrchestratorCharter, title: string) =>
    new Promise<void>((resolve, reject) => {
      void changes.saveCharter(next, title, (message) => reject(new Error(message))).then(resolve);
    });
  return (
    <SettingsGroup
      label="Routines"
      description="Briefs that start a worker or wake the orchestrator on a schedule."
      learnMore="A run missed while Gram was closed runs once on the next start. While the worker from a routine's last run is still live, its next run is skipped. Pausing the workspace pauses its routines; a run that came due meanwhile runs once on the resume. Their workers are the orchestrator's, under the same autonomy, worker cap and approvals. The orchestrator can add and change routines too; a worker can only ask you to approve one."
      keywords={["routine", "schedule", "recurring", "cron", "daily", "weekly", "nightly"]}
      testId="workspace-routines"
      action={
        !adding && (
          <Button
            size="sm"
            variant="outline"
            data-testid="routine-add"
            disabled={changes.busy}
            onClick={() => setAdding(true)}
          >
            <Plus data-icon="inline-start" />
            Add routine
          </Button>
        )
      }
    >
      {adding && (
        <RoutineEditor
          state={state}
          charter={charter}
          projects={projects}
          save={save}
          onDone={() => setAdding(false)}
        />
      )}
      {routines.length === 0 && !adding && (
        <p data-testid="routines-empty" className="text-body text-muted-foreground">
          No routines yet
        </p>
      )}
      {routines.map((routine) => (
        <RoutineRow
          key={routine.id ?? routine.name}
          routine={routine}
          status={statuses.find((each) => each.id === routine.id)}
          state={state}
          charter={charter}
          projects={projects}
          busy={changes.busy}
          save={save}
        />
      ))}
    </SettingsGroup>
  );
}

function targetText(
  routine: WorkspaceRoutine,
  state: WorkspaceState,
  projects: readonly Project[],
) {
  if (routine.target === "orchestrator") return "Wakes the orchestrator";
  const project = projectNameOf(projects, routine.project ?? state.workspace.homeProjectId);
  const model = routine.model === undefined ? "" : ` on ${modelLabel(routine.model)}`;
  return `Worker in ${project}${model}`;
}

/** "Daily at 09:00": the schedule's words, with a capital to start a line. */
const scheduleLine = (routine: WorkspaceRoutine) => {
  const words = routineScheduleText(routine.schedule);
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function RoutineRow({
  routine,
  status,
  state,
  charter,
  projects,
  busy: saving,
  save,
}: {
  routine: WorkspaceRoutine;
  status: RoutineStatus | undefined;
  state: WorkspaceState;
  charter: OrchestratorCharter;
  projects: readonly Project[];
  busy: boolean;
  save: (next: OrchestratorCharter, title: string) => Promise<void>;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const now = useNow(true, undefined, 30_000);
  const runs = status?.state ?? NO_STATE;
  const busy = saving || running;
  const others = (charter.routines ?? []).filter((each) => each !== routine);
  const act = (change: () => Promise<unknown>) => {
    setError(undefined);
    void change().catch((e: unknown) => setError(errorMessage(e)));
  };
  const replace = (next: WorkspaceRoutine | undefined) =>
    withRoutines(
      charter,
      (charter.routines ?? []).flatMap((each) =>
        each !== routine ? [each] : next === undefined ? [] : [next],
      ),
    );
  const runNow = () => {
    if (routine.id === undefined) return;
    setRunning(true);
    act(() =>
      api
        .runRoutine(state.workspace.id, routine.id!)
        .then(() => queryClient.invalidateQueries({ queryKey: ["routines", state.workspace.id] }))
        .finally(() => setRunning(false)),
    );
  };
  const actions: RowAction[] = [
    { label: "Edit…", icon: Pencil, disabled: busy, onSelect: () => setEditing(true) },
    {
      label: "Remove…",
      icon: Trash2,
      danger: true,
      disabled: busy,
      onSelect: () => setRemoving(true),
    },
  ];
  const run = runs.lastRun;
  if (editing) {
    return (
      <RoutineEditor
        state={state}
        charter={charter}
        projects={projects}
        routine={routine}
        others={others}
        save={(next, title) => save(next, title)}
        onDone={() => setEditing(false)}
      />
    );
  }
  return (
    <div data-testid="routine-row" data-routine={routine.name} className="flex flex-col gap-1">
      <div className="flex min-w-0 items-start gap-3">
        <Switch
          className="mt-0.5"
          aria-label={`Run ${routine.name} on its schedule`}
          checked={routine.off !== true}
          disabled={busy}
          onCheckedChange={(on) => {
            const { off: _off, ...rest } = routine;
            act(() =>
              save(
                replace(on ? rest : { ...rest, off: true }),
                on ? `Routine “${routine.name}” on` : `Routine “${routine.name}” off`,
              ),
            );
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-foreground" title={routine.name}>
            {routine.name}
          </span>
          <span data-testid="routine-summary" className="text-meta text-muted-foreground">
            {scheduleLine(routine)} · {targetText(routine, state, projects)}
          </span>
          <span data-testid="routine-runs" className="text-meta text-muted-foreground">
            {nextRunText(routine, runs, now)}
            {run !== undefined && (
              <>
                {" · "}
                <span className={cn(run.outcome === "failed" && "text-destructive")}>
                  {lastRunText(run, now)}
                </span>
                {run.threadId !== undefined && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      data-testid="routine-worker"
                      className="rounded-sm text-foreground/80 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => goToThread(run.threadId!)}
                    >
                      Open worker
                    </button>
                  </>
                )}
              </>
            )}
          </span>
          {run?.detail !== undefined && (
            <span
              data-testid="routine-detail"
              className={cn(
                "text-meta",
                run.outcome === "failed" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {run.detail}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            data-testid="routine-run-now"
            disabled={busy || state.paused !== undefined || routine.id === undefined}
            title={state.paused !== undefined ? "Resume the workspace to run routines" : undefined}
            onClick={runNow}
          >
            <Play data-icon="inline-start" />
            Run now
          </Button>
          <RowMenuButton label={`Routine ${routine.name} actions`} actions={actions} />
        </div>
      </div>
      {removing && (
        <div
          role="alertdialog"
          aria-label={`Remove ${routine.name}`}
          className="flex flex-wrap items-center gap-2 ps-12 text-meta"
        >
          <span className="text-muted-foreground">
            Remove “{routine.name}”? Workers it started carry on.
          </span>
          <Button
            size="sm"
            variant="destructive"
            data-testid="routine-remove-confirm"
            disabled={busy}
            onClick={() => act(() => save(replace(undefined), `Routine “${routine.name}” removed`))}
          >
            Remove
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRemoving(false)}>
            Cancel
          </Button>
        </div>
      )}
      {error !== undefined && (
        <p role="alert" className="ps-12 text-meta text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A routine's form: a new one's, or a saved one's to edit. Save stores it in the charter. */
function RoutineEditor({
  state,
  charter,
  projects,
  routine,
  others,
  save,
  onDone,
}: {
  state: WorkspaceState;
  charter: OrchestratorCharter;
  projects: readonly Project[];
  routine?: WorkspaceRoutine;
  others?: readonly WorkspaceRoutine[];
  save: (next: OrchestratorCharter, title: string) => Promise<void>;
  onDone: () => void;
}) {
  const ids = { name: useId(), brief: useId(), time: useId(), hours: useId() };
  const [form, setForm] = useState<RoutineForm>(() =>
    routine === undefined ? emptyRoutineForm() : formOfRoutine(routine),
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<RoutineForm>) => setForm((current) => ({ ...current, ...patch }));
  const repos = state.workspace.projectIds;
  const roster = charter.workerModels ?? [];

  const submit = () => {
    const made = routineOfForm(form, {
      editing: routine,
      others: others ?? charter.routines ?? [],
      roster,
    });
    if ("error" in made) return setError(made.error);
    setError(undefined);
    setBusy(true);
    const routines = charter.routines ?? [];
    const next =
      routine === undefined
        ? withRoutines(charter, [...routines, made.routine])
        : withRoutines(
            charter,
            routines.map((each) => (each === routine ? made.routine : each)),
          );
    void save(
      next,
      routine === undefined
        ? `Routine “${made.routine.name}” added`
        : `Routine “${made.routine.name}” saved`,
    )
      .then(onDone)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  return (
    <form
      data-testid="routine-editor"
      aria-label={routine === undefined ? "New routine" : `Edit ${routine.name}`}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.name} className={LABEL}>
          Name
        </label>
        <input
          id={ids.name}
          className={inputCls}
          value={form.name}
          maxLength={ROUTINE_NAME_MAX}
          placeholder="Daily CI triage"
          autoComplete="off"
          onChange={(event) => set({ name: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.brief} className={LABEL}>
          Brief
        </label>
        <textarea
          id={ids.brief}
          className={cn(inputCls, "h-auto min-h-20 max-w-none resize-y py-1.5 leading-snug")}
          rows={4}
          maxLength={ROUTINE_BRIEF_MAX}
          placeholder="What the worker does each time, written to stand alone."
          value={form.brief}
          onChange={(event) => set({ brief: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className={LABEL}>Runs</span>
        <div className="flex flex-wrap items-center gap-2">
          <OptionGroup
            label="Runs"
            options={EVERY_OPTIONS}
            value={form.every}
            onChange={(every) => set({ every })}
          />
          {form.every === "week" && (
            <select
              aria-label="Day"
              className={cn(inputCls, "w-36")}
              value={form.day}
              onChange={(event) => set({ day: Number(event.target.value) })}
            >
              {/* Monday first, as the week reads. */}
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <option key={day} value={day}>
                  {ROUTINE_DAYS[day]}
                </option>
              ))}
            </select>
          )}
          {form.every !== "hours" ? (
            <span className="flex items-center gap-1.5">
              <label htmlFor={ids.time} className="text-meta text-muted-foreground">
                at
              </label>
              <input
                id={ids.time}
                aria-label="Time"
                className={cn(inputCls, "w-20 font-mono")}
                value={form.at}
                placeholder="09:00"
                inputMode="numeric"
                autoComplete="off"
                onChange={(event) => set({ at: event.target.value })}
              />
              <span className="text-meta text-muted-foreground">local time</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <label htmlFor={ids.hours} className="text-meta text-muted-foreground">
                every
              </label>
              <input
                id={ids.hours}
                aria-label="Hours"
                type="number"
                min={ROUTINE_MIN_INTERVAL_HOURS}
                max={ROUTINE_MAX_INTERVAL_HOURS}
                className={cn(inputCls, "w-20")}
                value={form.hours}
                onChange={(event) => set({ hours: event.target.value })}
              />
              <span className="text-meta text-muted-foreground">hours</span>
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className={LABEL}>Each run</span>
        <div className="flex flex-wrap items-center gap-2">
          <OptionGroup
            label="Each run"
            options={[
              { value: "worker", label: "Starts a worker" },
              { value: "orchestrator", label: "Wakes the orchestrator" },
            ]}
            value={form.target}
            onChange={(target) => set({ target })}
          />
          {form.target === "worker" && (
            <>
              <select
                aria-label="Repository"
                className={cn(inputCls, "w-44")}
                value={form.project}
                onChange={(event) => set({ project: event.target.value })}
              >
                <option value="">
                  {projectNameOf(projects, state.workspace.homeProjectId)} (home)
                </option>
                {repos
                  .filter((id) => id !== state.workspace.homeProjectId)
                  .map((id) => (
                    <option key={id} value={id}>
                      {projectNameOf(projects, id)}
                    </option>
                  ))}
              </select>
              <select
                aria-label="Model"
                className={cn(inputCls, "w-56")}
                value={form.model}
                onChange={(event) => set({ model: event.target.value })}
              >
                <option value="">Workspace default model</option>
                {roster.map((model) => {
                  const value = modelLabel(model);
                  return (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  );
                })}
              </select>
            </>
          )}
        </div>
      </div>
      {error !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" type="submit" data-testid="routine-save" disabled={busy}>
          {routine === undefined ? "Add routine" : "Save routine"}
        </Button>
        <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
