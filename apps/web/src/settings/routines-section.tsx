import {
  ROUTINE_BRIEF_MAX,
  ROUTINE_DAY_NAMES,
  ROUTINE_DAYS,
  ROUTINE_MAX_INTERVAL_HOURS,
  ROUTINE_MIN_INTERVAL_HOURS,
  ROUTINE_NAME_MAX,
  routineScheduleText,
  type Project,
  type ProjectId,
  type Routine,
  type RoutineDay,
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
  draftOfForm,
  emptyRoutineForm,
  EVERY_OPTIONS,
  formOfRoutine,
  lastRunText,
  nextRunText,
  type RoutineForm,
} from "./routines-model";
import { SettingsGroup } from "./settings-group";
import { projectNameOf } from "./workspace-settings-model";

const LABEL = "text-meta font-medium text-foreground";

/**
 * Workspace settings → Routines: the workspace's saved briefs that run on a schedule, each with a
 * switch, Run now, its last and next run, and Edit and Remove in its menu. Add routine opens the
 * same form a row's Edit does, above the list.
 */
export function RoutinesSection({
  state,
  projects,
}: {
  state: WorkspaceState;
  projects: readonly Project[];
}) {
  const api = useApi();
  const workspaceId = state.workspace.id;
  const { data: routines = [], isPending } = useQuery({
    queryKey: ["routines", workspaceId],
    queryFn: () => api.listRoutines(workspaceId),
  });
  const [adding, setAdding] = useState(false);
  return (
    <SettingsGroup
      label="Routines"
      description="Saved briefs that start a worker or wake the orchestrator on a schedule."
      learnMore="A run missed while Gram was closed runs once on the next start. While the worker from a routine's last run is still live, its next run is skipped. Pausing the workspace pauses its routines; a run that came due meanwhile runs once on the resume. Their workers are the orchestrator's, under the same autonomy, worker cap and approvals."
      keywords={["routine", "schedule", "recurring", "cron", "daily", "weekly", "nightly"]}
      testId="workspace-routines"
      action={
        !adding && (
          <Button
            size="sm"
            variant="outline"
            data-testid="routine-add"
            onClick={() => setAdding(true)}
          >
            <Plus data-icon="inline-start" />
            Add routine
          </Button>
        )
      }
    >
      {adding && (
        <RoutineEditor state={state} projects={projects} onDone={() => setAdding(false)} />
      )}
      {!isPending && routines.length === 0 && !adding && (
        <p data-testid="routines-empty" className="text-body text-muted-foreground">
          No routines yet
        </p>
      )}
      {routines.map((routine) => (
        <RoutineRow key={routine.id} routine={routine} state={state} projects={projects} />
      ))}
    </SettingsGroup>
  );
}

function targetText(routine: Routine, projects: readonly Project[]) {
  if (routine.target.kind === "orchestrator") return "Wakes the orchestrator";
  const model = routine.target.model === undefined ? "" : ` on ${routine.target.model}`;
  return `Worker in ${projectNameOf(projects, routine.target.projectId)}${model}`;
}

function RoutineRow({
  routine,
  state,
  projects,
}: {
  routine: Routine;
  state: WorkspaceState;
  projects: readonly Project[];
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const now = useNow(true, undefined, 30_000);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["routines", routine.workspaceId] });
  const act = (change: () => Promise<unknown>) => {
    setError(undefined);
    setBusy(true);
    void change()
      .then(refresh)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
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
  const run = routine.lastRun;
  if (editing) {
    return (
      <RoutineEditor
        state={state}
        projects={projects}
        routine={routine}
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
          checked={routine.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => act(() => api.updateRoutine(routine.id, { enabled }))}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-foreground" title={routine.name}>
            {routine.name}
          </span>
          <span data-testid="routine-summary" className="text-meta text-muted-foreground">
            {routineScheduleText(routine.schedule)} · {targetText(routine, projects)}
          </span>
          <span data-testid="routine-runs" className="text-meta text-muted-foreground">
            {nextRunText(routine, now)}
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
            disabled={busy || state.paused !== undefined}
            title={state.paused !== undefined ? "Resume the workspace to run routines" : undefined}
            onClick={() => act(() => api.runRoutine(routine.id))}
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
            onClick={() => act(() => api.removeRoutine(routine.id))}
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

/** A routine's form: a new one's, or a saved one's to edit. Save sends it whole. */
function RoutineEditor({
  state,
  projects,
  routine,
  onDone,
}: {
  state: WorkspaceState;
  projects: readonly Project[];
  routine?: Routine;
  onDone: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const ids = { name: useId(), brief: useId(), time: useId(), day: useId(), hours: useId() };
  const projectId = useId();
  const modelId = useId();
  const [form, setForm] = useState<RoutineForm>(() =>
    routine === undefined
      ? emptyRoutineForm(state.workspace.homeProjectId)
      : formOfRoutine(routine),
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<RoutineForm>) => setForm((current) => ({ ...current, ...patch }));
  const repos = state.workspace.projectIds;
  const models = state.charter.workerModels ?? [];

  const save = () => {
    const made = draftOfForm(form);
    if ("error" in made) return setError(made.error);
    setError(undefined);
    setBusy(true);
    const workspaceId = state.workspace.id;
    void (
      routine === undefined
        ? api.createRoutine(workspaceId, made.draft)
        : api.updateRoutine(routine.id, made.draft)
    )
      .then(() => queryClient.invalidateQueries({ queryKey: ["routines", workspaceId] }))
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
        save();
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
          {form.every === "weekly" && (
            <select
              id={ids.day}
              aria-label="Day"
              className={cn(inputCls, "w-36")}
              value={form.day}
              onChange={(event) => set({ day: event.target.value as RoutineDay })}
            >
              {ROUTINE_DAYS.map((day) => (
                <option key={day} value={day}>
                  {ROUTINE_DAY_NAMES[day]}
                </option>
              ))}
            </select>
          )}
          {form.every !== "interval" ? (
            <span className="flex items-center gap-1.5">
              <label htmlFor={ids.time} className="text-meta text-muted-foreground">
                at
              </label>
              <input
                id={ids.time}
                aria-label="Time"
                className={cn(inputCls, "w-20 font-mono")}
                value={form.time}
                placeholder="09:00"
                inputMode="numeric"
                autoComplete="off"
                onChange={(event) => set({ time: event.target.value })}
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
                id={projectId}
                aria-label="Repository"
                className={cn(inputCls, "w-44")}
                value={form.projectId ?? ""}
                onChange={(event) => set({ projectId: event.target.value as ProjectId })}
              >
                {repos.map((id) => (
                  <option key={id} value={id}>
                    {projectNameOf(projects, id)}
                  </option>
                ))}
              </select>
              <select
                id={modelId}
                aria-label="Model"
                className={cn(inputCls, "w-56")}
                value={form.model}
                onChange={(event) => set({ model: event.target.value })}
              >
                <option value="">Workspace default model</option>
                {models.map((model) => {
                  const value = `${model.agent}:${model.model}`;
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
