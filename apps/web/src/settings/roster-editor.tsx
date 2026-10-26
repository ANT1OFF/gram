import {
  DEFAULT_ORCHESTRATOR_MODEL,
  WORKER_MODEL_NOTE_MAX,
  type AgentKind,
  type ModelRef,
  type OrchestratorCharter,
  type ReasoningVariant,
  type WorkerModel,
} from "@gram/contracts";
import { Popover } from "@base-ui/react/popover";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleHelp, Plus, Star, TriangleAlert, X } from "lucide-react";
import { useId, useState } from "react";
import { flushSync } from "react-dom";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { SpeedField } from "@/composer/speed-field";
import { AgentFields, choiceModel, type AgentChoice } from "@/composer/agent-fields";
import { choiceFromModel } from "@/composer/default-choice";
import {
  UNLISTED_EFFORTS,
  effortOptions,
  effortsUnlisted,
  useModels,
  useModelsSettled,
} from "@/composer/models";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ExpandPresence, PresenceItem, PresenceList } from "@/motion";
import { ADMITTED_AGENTS } from "@/orchestration/admitted";
import { useServerSettings } from "@/settings-sync/store";

import { Field, inputCls, LONG_COPY, WhyDisabled } from "./fields";
import {
  addWorkerModel,
  defaultWorkerIndex,
  DREAM_HARNESS_NOTE,
  HARNESS_GENERAL_NOTE,
  harnessNotes,
  sameModelRef,
  withDefaultWorker,
  withOrchestratorModel,
  withUseFor,
  withWorkerModels,
  withWorkerNote,
  workerModelIssues,
  type WorkerModelIssue,
} from "./workspace-settings-model";

// The roster editor: a workspace's orchestrator model and its worker models, each with the user's
// note on what it is for, its effort and which is the default. It reads and writes only those two
// fields of a charter, so Settings → Workspaces and the new-workspace sheet can both use it on a
// charter of their own, saved or still a draft.

/** What `RosterEditor` takes. */
export interface RosterEditorProps {
  /**
   * The charter being edited, saved or a draft. Only `orchestratorModel` and `workerModels` are
   * changed; `autonomy` is read for what a spawn would refuse.
   */
  readonly charter: OrchestratorCharter;
  readonly disabled?: boolean | undefined;
  /** The charter with the user's change, every other field as it came in. Called per change. */
  readonly onChange: (charter: OrchestratorCharter) => void;
}

const START: AgentChoice = {
  agent: "claude",
  model: "opus",
  speed: "standard",
};

const NOTE_PLACEHOLDER = "Use it for… e.g. reviews, bug hunts, audits, tightly scoped changes";

/** The effort select's value for "the model's own default". */
const DEFAULT_EFFORT = "default";

/** A model as a list names it: `Codex gpt-6-sol`. */
const modelName = (model: ModelRef): string => `${agentLabel(model.agent)} ${model.model}`;

/**
 * What a roster entry is for, in the user's words. Kept as a draft while typed and saved when the
 * field is left or Enter is pressed, so a note isn't a charter write per keystroke.
 */
function UseForField({
  model,
  disabled,
  onCommit,
}: {
  model: WorkerModel;
  disabled: boolean;
  onCommit: (note: string) => void;
}) {
  const saved = model.useFor ?? "";
  const [draft, setDraft] = useState(saved);
  const [was, setWas] = useState(saved);
  // A note saved elsewhere, or put back by a refused save, replaces a draft nobody is typing.
  if (saved !== was) {
    setWas(saved);
    setDraft(saved);
  }
  const commit = () => {
    if (draft.trim() !== saved) onCommit(draft);
  };
  return (
    <input
      data-testid="worker-model-note"
      aria-label={`What ${modelName(model)} is for`}
      className={cn(inputCls, "h-7 max-w-none text-xs")}
      placeholder={NOTE_PLACEHOLDER}
      maxLength={WORKER_MODEL_NOTE_MAX}
      spellCheck={false}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          if (!event.metaKey && !event.ctrlKey) event.preventDefault();
          // Create runs later in this event and must see the note still being edited.
          flushSync(commit);
        }
      }}
    />
  );
}

/**
 * An entry's effort, from what its model offers. The entry's own effort stays among the choices
 * when the list doesn't name it, as a gateway that advertises no efforts can still take one.
 */
function EffortField({
  model,
  disabled,
  onChange,
}: {
  model: WorkerModel;
  disabled: boolean;
  onChange: (variant: ReasoningVariant | undefined) => void;
}) {
  const models = useModels(model.agent, model.profileId);
  const offered = effortOptions(models, model.model);
  const options =
    model.variant === undefined || offered.some((option) => option.value === model.variant)
      ? offered
      : [...offered, { value: model.variant, label: `${model.variant} effort` }];
  if (options.length === 0) return null;
  return (
    <select
      data-testid="worker-model-effort"
      aria-label={`Effort for ${modelName(model)}`}
      title={effortsUnlisted(models, model.model) ? UNLISTED_EFFORTS : undefined}
      className="h-7 rounded-md border border-input bg-transparent px-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      value={model.variant ?? DEFAULT_EFFORT}
      disabled={disabled}
      onChange={(event) =>
        onChange(
          event.target.value === DEFAULT_EFFORT
            ? undefined
            : (event.target.value as ReasoningVariant),
        )
      }
    >
      <option value={DEFAULT_EFFORT}>Default effort</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function WorkerSpeedField({
  model,
  disabled,
  onChange,
}: {
  model: WorkerModel;
  disabled: boolean;
  onChange: (model: WorkerModel) => void;
}) {
  const models = useModels(model.agent, model.profileId);
  return (
    <SpeedField
      agent={model.agent}
      model={model.model}
      models={models}
      value={model.speed}
      disabled={disabled}
      size="sm"
      onChange={(speed) => onChange({ ...model, speed })}
    />
  );
}

/** `model` at `variant`, or at its model's own default effort. */
const withVariant = (model: WorkerModel, variant: ReasoningVariant | undefined): WorkerModel => {
  const { variant: _was, ...rest } = model;
  return variant === undefined ? rest : { ...rest, variant };
};

/**
 * The model this workspace's orchestrator opens on: the app's default model, or one of its own. An
 * open orchestrator keeps the model it opened on; the next one takes this. What it shows is always
 * the charter's, so a workspace loaded, or saved from elsewhere, after this mounted shows its own;
 * only an agent picked whose model isn't listed yet is held here until it is.
 */
function OrchestratorModelField({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter) => void;
}) {
  const selectId = useId();
  const defaultModel = useServerSettings((state) => state.settings?.agents.defaultModel);
  const own = charter.orchestratorModel;
  const [pending, setPending] = useState<AgentChoice>();
  const shown = pending ?? choiceFromModel(own ?? defaultModel ?? DEFAULT_ORCHESTRATOR_MODEL);
  const pick = (next: AgentChoice) => {
    // A gateway agent's model is filled in once its models are listed; nothing is saved before.
    if (next.model === "") {
      setPending(next);
      return;
    }
    setPending(undefined);
    onChange(withOrchestratorModel(charter, choiceModel(next)));
  };
  const follows =
    defaultModel === undefined
      ? "Follow your default model"
      : `Follow your default model: ${modelName(defaultModel)}`;
  return (
    <Field
      label="Orchestrator model"
      description="Sets the next orchestrator's model. Use Switch orchestrator to change the current session."
      htmlFor={selectId}
      keywords={["orchestrator", "model", "opus", "main model", "effort"]}
    >
      <div data-testid="orchestrator-model" className="flex flex-col gap-2">
        <select
          id={selectId}
          data-testid="orchestrator-model-follow"
          className={cn(inputCls, "w-fit")}
          value={own === undefined && pending === undefined ? "follow" : "own"}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === "follow") {
              setPending(undefined);
              onChange(withOrchestratorModel(charter, undefined));
              return;
            }
            pick(ADMITTED_AGENTS.includes(shown.agent) ? shown : START);
          }}
        >
          <option value="follow">{follows}</option>
          <option value="own">A model of its own</option>
        </select>
        {(own !== undefined || pending !== undefined) && (
          <div className="flex flex-wrap items-center gap-2">
            <AgentFields value={shown} onChange={pick} allowed={ADMITTED_AGENTS} />
          </div>
        )}
      </div>
    </Field>
  );
}

/**
 * "How Codex differs": what to know before letting a harness take a role, and how a Dream is held
 * on each, behind a ? on the worker models' line while such a harness is in use.
 */
function HarnessNotes({
  notes,
}: {
  notes: readonly {
    readonly agent: AgentKind;
    readonly notes: readonly string[];
  }[];
}) {
  if (notes.length === 0) return null;
  const label = `How ${notes.map((each) => agentLabel(each.agent)).join(" and ")} differs`;
  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid="harness-notes"
        className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CircleHelp aria-hidden className="size-3.5" />
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-surface="overlay"
            aria-label={label}
            {...{ [LONG_COPY]: "learn more" }}
            className="flex max-h-(--available-height) max-w-md origin-(--transform-origin) flex-col gap-2 overflow-y-auto rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            {notes.map(({ agent, notes: lines }) => (
              <section key={agent} data-testid={`harness-note-${agent}`}>
                <h4 className="font-medium">{agentLabel(agent)}</h4>
                <ul className="flex list-disc flex-col gap-0.5 pt-1 pl-4 text-muted-foreground">
                  {lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
            ))}
            <section data-testid="harness-note-dreams">
              <h4 className="font-medium">Dream</h4>
              <p className="pt-1 text-muted-foreground">{DREAM_HARNESS_NOTE}</p>
            </section>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The ids an agent listed on its own login; `null` once it couldn't, `undefined` until it answers. */
const ownIds = (listed: ReturnType<typeof useModelsSettled>) =>
  listed.settled
    ? (listed.models?.flatMap((model) => [
        model.id,
        ...(model.resolvedId === undefined ? [] : [model.resolvedId]),
        "default",
      ]) ?? null)
    : undefined;

/** What an entry is checked against: the profiles, and what Codex offer on their own. */
function useWorkerModelIssues(
  charter: Pick<OrchestratorCharter, "workerModels" | "autonomy">,
): readonly WorkerModelIssue[] {
  const api = useApi();
  const { data: profiles } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });
  const claude = useModelsSettled("claude");
  const codex = useModelsSettled("codex");
  const claudeOwn = ownIds(claude);
  const codexOwn = ownIds(codex);
  const custom = useServerSettings((state) => state.settings?.agents.customModels);
  const customModels: Partial<Record<AgentKind, string[]>> = {};
  for (const model of custom ?? []) (customModels[model.agent] ??= []).push(model.id);
  return workerModelIssues(charter, {
    profiles,
    customModels,
    ownModels: {
      ...(claudeOwn === undefined ? {} : { claude: claudeOwn }),
      ...(codexOwn === undefined ? {} : { codex: codexOwn }),
    },
  });
}

/** An entry's warning, with a link to where it is fixed when it can't run here. */
function IssueNote({ issue }: { issue: WorkerModelIssue }) {
  return (
    <p
      role="status"
      data-testid="worker-model-warning"
      data-unavailable={issue.unavailable === undefined ? undefined : true}
      className="flex items-start gap-1.5 text-xs text-warning"
    >
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>
        {issue.message}
        {issue.unavailable?.fix === "agents" && (
          <>
            {" "}
            <Link
              to="/settings/agents"
              className="font-medium text-foreground underline underline-offset-2"
            >
              Set up your local agent in Settings → Agents
            </Link>
          </>
        )}
        {issue.unavailable?.fix === "gateways" && (
          <>
            {" "}
            <Link
              to="/settings/gateways"
              className="font-medium text-foreground underline underline-offset-2"
            >
              Add a gateway key in Settings → Gateways
            </Link>
          </>
        )}
      </span>
    </p>
  );
}

/**
 * The orchestrator model and the worker model roster. Each model is
 * picked with the app's own agent, profile, model and effort pickers and carries the user's note on
 * what it is for, which the orchestrator picks by; one may be the default. What the server would
 * refuse or pass over at spawn is said beside the entry and never blocks a save, since the server
 * is the authority; how a harness differs is behind a ? on the list's line while it is in the list or
 * is the default model's.
 */
export function RosterEditor({ charter, disabled = false, onChange }: RosterEditorProps) {
  const api = useApi();
  const { data: profiles } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });
  const [adding, setAdding] = useState(false);
  const startingChoice = (): AgentChoice => {
    const selected =
      charter.orchestratorModel ?? useServerSettings.getState().settings?.agents.defaultModel;
    return {
      agent: selected?.agent ?? "claude",
      model: "",
      speed: "standard",
      ...(selected?.profileId === undefined ? {} : { profileId: selected.profileId }),
    };
  };
  const [choice, setChoice] = useState<AgentChoice>(startingChoice);
  const [note, setNote] = useState("");
  const models = charter.workerModels ?? [];
  const fallback = defaultWorkerIndex(models);
  const issues = useWorkerModelIssues(charter);
  // Checked before it is added, so an entry that can't run here says so while it is only a choice.
  const candidate = choice.model === "" ? undefined : withUseFor(choiceModel(choice), note);
  const candidateIssue = useWorkerModelIssues({
    ...charter,
    workerModels: candidate === undefined ? models : [...models, candidate],
  }).find((issue) => candidate !== undefined && issue.index === models.length);
  // The default model is what an orchestrator following it, and a worker with no roster, runs on.
  const defaultAgent = useServerSettings((state) => state.settings?.agents.defaultModel?.agent);
  const notes = harnessNotes(
    [...models, ...(charter.orchestratorModel === undefined ? [] : [charter.orchestratorModel])],
    defaultAgent,
  );
  const profileName = (model: ModelRef): string | undefined =>
    model.profileId === undefined
      ? undefined
      : (profiles?.find((profile) => profile.id === model.profileId)?.name ?? model.profileId);
  const replace = (index: number, next: WorkerModel) => {
    if (models.some((model, i) => i !== index && sameModelRef(model, next))) return;
    onChange(
      withWorkerModels(
        charter,
        models.map((model, i) => (i === index ? next : model)),
      ),
    );
  };

  return (
    <>
      <OrchestratorModelField charter={charter} disabled={disabled} onChange={onChange} />
      <Field
        label="Worker models"
        description="Models the orchestrator may give workers, each with a note on when to use it."
        learnMore={
          <>
            <p>
              It picks a model per worker by your notes and says which it picked. A worker it names
              no model for, or one on a model that can&apos;t run here, gets the default. With none
              listed, workers run on the orchestrator&apos;s own model.
            </p>
            <p>{HARNESS_GENERAL_NOTE}</p>
          </>
        }
        action={<HarnessNotes notes={notes} />}
        keywords={[
          "codex",
          "claude",
          "gateway",
          "profile",
          "harness",
          "model",
          "roster",
          "use for",
          "default",
          "effort",
        ]}
      >
        <div data-testid="worker-models" className="flex flex-col gap-2">
          {models.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              <PresenceList>
                {models.map((model, index) => {
                  const issue = issues.find((each) => each.index === index);
                  const profile = profileName(model);
                  const isDefault = index === fallback;
                  return (
                    <PresenceItem
                      as="li"
                      key={JSON.stringify([
                        model.agent,
                        model.profileId,
                        model.model,
                        model.variant,
                      ])}
                      data-testid="worker-model"
                      data-agent={model.agent}
                      data-default={isDefault || undefined}
                      data-unavailable={issue?.unavailable === undefined ? undefined : true}
                      className={cn(
                        "flex flex-col gap-1 rounded-md border border-border p-2",
                        issue?.unavailable !== undefined && "border-dashed",
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <span className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                          <AgentIcon
                            agent={model.agent}
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                          <span className="shrink-0">{agentLabel(model.agent)}</span>
                          <span className="min-w-0 font-mono text-xs break-all">{model.model}</span>
                          <WorkerSpeedField
                            model={model}
                            disabled={disabled}
                            onChange={(next) => replace(index, next)}
                          />
                          <EffortField
                            model={model}
                            disabled={disabled}
                            onChange={(variant) => replace(index, withVariant(model, variant))}
                          />
                          {profile !== undefined && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {profile}
                            </span>
                          )}
                        </span>
                        <span className="flex h-7 shrink-0 items-center gap-1">
                          <Button
                            size="xs"
                            variant={isDefault ? "secondary" : "ghost"}
                            data-testid="worker-model-default"
                            aria-pressed={isDefault}
                            aria-label={`Default worker model: ${modelName(model)}`}
                            title={
                              isDefault
                                ? "A worker the orchestrator names no model for gets this one"
                                : "Make this the model a worker gets when the orchestrator names none"
                            }
                            disabled={disabled}
                            onClick={() =>
                              onChange(withWorkerModels(charter, withDefaultWorker(models, index)))
                            }
                          >
                            <Star
                              data-icon="inline-start"
                              className={cn(isDefault && "fill-current text-primary")}
                            />
                            Default
                          </Button>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Remove ${modelName(model)}`}
                            disabled={disabled}
                            onClick={() =>
                              onChange(
                                withWorkerModels(
                                  charter,
                                  models.filter((_, i) => i !== index),
                                ),
                              )
                            }
                          >
                            <X />
                          </Button>
                        </span>
                      </div>
                      <UseForField
                        model={model}
                        disabled={disabled}
                        onCommit={(next) =>
                          onChange(withWorkerModels(charter, withWorkerNote(models, index, next)))
                        }
                      />
                      {issue !== undefined && <IssueNote issue={issue} />}
                    </PresenceItem>
                  );
                })}
              </PresenceList>
            </ul>
          )}
          <ExpandPresence open={adding}>
            <div
              data-testid="worker-model-form"
              className="flex flex-col gap-2 rounded-md border border-border bg-card/40 p-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <AgentFields value={choice} onChange={setChoice} allowed={ADMITTED_AGENTS} />
              </div>
              <input
                data-testid="worker-model-form-note"
                aria-label="What this model is for"
                className={cn(inputCls, "max-w-none")}
                placeholder={NOTE_PLACEHOLDER}
                maxLength={WORKER_MODEL_NOTE_MAX}
                spellCheck={false}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              {candidateIssue !== undefined && <IssueNote issue={candidateIssue} />}
              <div className="flex gap-2">
                <WhyDisabled
                  reason={!disabled && choice.model === "" ? "Pick a model first." : undefined}
                >
                  <Button
                    size="sm"
                    data-testid="worker-model-save"
                    disabled={disabled || choice.model === ""}
                    onClick={() => {
                      onChange(
                        withWorkerModels(
                          charter,
                          addWorkerModel(models, withUseFor(choiceModel(choice), note)),
                        ),
                      );
                      setAdding(false);
                      setChoice(startingChoice());
                      setNote("");
                    }}
                  >
                    {candidateIssue?.unavailable === undefined
                      ? "Add to the list"
                      : "Add for later"}
                  </Button>
                </WhyDisabled>
                <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </ExpandPresence>
          {!adding && (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              data-testid="worker-model-add"
              disabled={disabled}
              onClick={() => setAdding(true)}
            >
              <Plus data-icon="inline-start" />
              Add a model
            </Button>
          )}
        </div>
      </Field>
    </>
  );
}
