import {
  aboveHigh,
  defaultOrchestratorModel,
  defaultSlotOf,
  isPinned,
  isTierRef,
  modelSlotOf,
  WORKER_MODEL_NOTE_MAX,
  type AgentKind,
  type ModelRef,
  type OrchestratorCharter,
  type PinnedWorkerModel,
  ReasoningVariant,
  type RosterModel,
  type TierRef,
  type WorkerModel,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Star, TriangleAlert, X } from "lucide-react";
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
import { useAdmittedAgents } from "@/orchestration/admitted";
import { useServerSettings } from "@/settings-sync/store";

import { Field, inputCls, WhyDisabled } from "./fields";
import { HarnessNotes } from "./harness-notes";
import {
  followOfPinned,
  sameSlot,
  slotAfterPick,
  useAvailableModels,
  useDefaultHere,
  useDefaultModel,
  useRosterHere,
  useSlotHere,
  useSlotModel,
} from "./model-slots";
import { FollowButton, SlotGlyph, useRecommendedOn } from "./slot-glyph";
import {
  addWorkerModel,
  defaultWorkerIndex,
  HARNESS_GENERAL_NOTE,
  harnessNotes,
  withDefaultWorker,
  withOrchestratorModel,
  pinnedWithUseFor,
  withWorkerModels,
  withWorkerNote,
  workerModelIssues,
  type WorkerModelIssue,
} from "./workspace-settings-model";

/** What `RosterEditor` takes. */
export interface RosterEditorProps {
  /**
   * The charter being edited, saved or a draft. Only `orchestratorModel` and `workerModels` are
   * changed; `autonomy` is read for what a spawn would refuse.
   */
  readonly charter: OrchestratorCharter;
  readonly disabled?: boolean | undefined;
  /** What the model controls here, when editing a draft before a workspace has an orchestrator. */
  readonly orchestratorDescription?: string | undefined;
  /** The charter with the user's change, every other field as it came in. Called per change. */
  readonly onChange: (charter: OrchestratorCharter) => void;
}

const START: AgentChoice = {
  agent: "claude",
  model: "opus",
  speed: "standard",
};

const NOTE_PLACEHOLDER = "Use it for… e.g. reviews, bug hunts, audits, tightly scoped changes";

const DEFAULT_EFFORT = "default";
const isReasoningVariant = Schema.is(ReasoningVariant);

const modelName = (model: ModelRef): string => `${agentLabel(model.agent)} ${model.model}`;

function UseForField({
  model,
  placeholder = NOTE_PLACEHOLDER,
  disabled,
  onCommit,
}: {
  model: PinnedWorkerModel;
  placeholder?: string | undefined;
  disabled: boolean;
  onCommit: (note: string) => void;
}) {
  const saved = model.useFor ?? "";
  const [draft, setDraft] = useState(saved);
  const [was, setWas] = useState(saved);
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
      className={cn(inputCls, "h-7 max-w-none text-meta")}
      placeholder={placeholder}
      maxLength={WORKER_MODEL_NOTE_MAX}
      spellCheck={false}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          if (!event.metaKey && !event.ctrlKey) event.preventDefault();
          flushSync(commit);
        }
      }}
    />
  );
}

function EffortField({
  model,
  follows,
  disabled,
  onChange,
}: {
  model: PinnedWorkerModel;
  follows: boolean;
  disabled: boolean;
  onChange: (variant: ReasoningVariant | undefined) => void;
}) {
  const models = useModels(model.agent, model.profileId);
  const listed = effortOptions(models, model.model);
  const offered = follows ? listed.filter((option) => !aboveHigh(option.value)) : listed;
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
      className="h-7 rounded-md border border-input bg-transparent px-1.5 text-reading outline-none focus-visible:ring-2 focus-visible:ring-ring"
      value={model.variant ?? DEFAULT_EFFORT}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        if (next === DEFAULT_EFFORT) onChange(undefined);
        else if (isReasoningVariant(next)) onChange(next);
      }}
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
  model: PinnedWorkerModel;
  disabled: boolean;
  onChange: (model: PinnedWorkerModel) => void;
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

const withVariant = (
  model: PinnedWorkerModel,
  variant: ReasoningVariant | undefined,
): PinnedWorkerModel => {
  const { variant: _was, ...rest } = model;
  return variant === undefined ? rest : { ...rest, variant };
};

const followAt = (
  stored: Extract<WorkerModel, TierRef>,
  view: PinnedWorkerModel,
  variant: ReasoningVariant | undefined,
): WorkerModel => {
  const { variant: _was, ...rest } = stored;
  if (variant === undefined) return rest;
  return aboveHigh(variant) ? withVariant(view, variant) : { ...rest, variant };
};

const pinView = (view: RosterModel, stored: WorkerModel): PinnedWorkerModel => {
  const { tier: _tier, tierAgent: _tierAgent, useFor: _useFor, ...model } = view;
  return stored.useFor === undefined ? model : { ...model, useFor: stored.useFor };
};

function OrchestratorModelField({
  charter,
  disabled,
  onChange,
  description = "Sets the next orchestrator's model. Continue in… moves the current one.",
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter) => void;
  description?: string | undefined;
}) {
  const admitted = useAdmittedAgents();
  const selectId = useId();
  const inherited = useDefaultHere();
  const defaultModel = inherited.model;
  const defaultSlot = useServerSettings((state) =>
    state.settings === undefined ? undefined : defaultSlotOf(state.settings),
  );
  const own = charter.orchestratorModel;
  const ownFollows = own !== undefined && isTierRef(own);
  const slot = useSlotHere(own);
  const ownHere = slot.model;
  const missing = own === undefined ? inherited.missing : slot.missing;
  const [pending, setPending] = useState<AgentChoice>();
  const installed = useAvailableModels(own === undefined && defaultModel === undefined);
  const shown =
    pending ?? choiceFromModel(ownHere ?? defaultModel ?? defaultOrchestratorModel(installed));
  const pick = (next: AgentChoice) => {
    if (next.model === "") {
      setPending(next);
      return;
    }
    setPending(undefined);
    onChange(
      withOrchestratorModel(
        charter,
        ownFollows ? slotAfterPick(own, ownHere, choiceModel(next)) : choiceModel(next),
      ),
    );
  };
  const follow = () => onChange(withOrchestratorModel(charter, { tier: "lead" }));
  const inheriting = own === undefined && pending === undefined;
  const follows =
    defaultModel === undefined
      ? "Follow your default model"
      : `Follow your default model: ${modelName(defaultModel)}`;
  return (
    <Field
      label="Orchestrator model"
      description={description}
      htmlFor={selectId}
      keywords={["orchestrator", "model", "opus", "main model", "effort"]}
    >
      <div data-testid="orchestrator-model" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {inheriting && <SlotGlyph slot={defaultSlot} />}
          <select
            id={selectId}
            data-testid="orchestrator-model-follow"
            className={cn(inputCls, "w-fit")}
            value={inheriting ? "follow" : "own"}
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value === "follow") {
                setPending(undefined);
                onChange(withOrchestratorModel(charter, undefined));
                return;
              }
              pick(admitted.includes(shown.agent) ? shown : START);
            }}
          >
            <option value="follow">{follows}</option>
            <option value="own">A model of its own</option>
          </select>
          {inheriting && <FollowButton slot={defaultSlot} disabled={disabled} onFollow={follow} />}
        </div>
        {!inheriting && (
          <div className="flex flex-wrap items-center gap-2">
            {pending === undefined && <SlotGlyph slot={own} />}
            <AgentFields
              value={shown}
              onChange={pick}
              allowed={admitted}
              follows={pending === undefined && ownFollows}
            />
            {pending === undefined && (
              <FollowButton slot={own} disabled={disabled} onFollow={follow} />
            )}
          </div>
        )}
        {missing !== undefined && (
          <IssueNote
            issue={{
              index: -1,
              message:
                own === undefined
                  ? `Your default model is unavailable: ${missing}. The orchestrator opens on what Gram finds installed instead.`
                  : `Unavailable: ${missing[0]!.toUpperCase()}${missing.slice(1)}. The orchestrator opens on your default model instead.`,
            }}
          />
        )}
      </div>
    </Field>
  );
}

const ownIds = (listed: ReturnType<typeof useModelsSettled>) =>
  listed.settled
    ? (listed.models?.flatMap((model) => [
        model.id,
        ...(model.resolvedId === undefined ? [] : [model.resolvedId]),
        "default",
      ]) ?? null)
    : undefined;

function useWorkerModelIssues(
  charter: Parameters<typeof workerModelIssues>[0],
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

function IssueNote({ issue }: { issue: WorkerModelIssue }) {
  return (
    <p
      role="status"
      data-testid="worker-model-warning"
      data-unavailable={issue.unavailable === undefined ? undefined : true}
      className="flex items-start gap-1.5 text-meta text-warning"
    >
      <TriangleAlert aria-hidden className="mt-px size-icon-row shrink-0" />
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
export function RosterEditor({
  charter,
  disabled = false,
  onChange,
  orchestratorDescription,
}: RosterEditorProps) {
  const admitted = useAdmittedAgents();
  const api = useApi();
  const { data: profiles } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });
  const [adding, setAdding] = useState(false);
  const orchestratorHere = useSlotModel(charter.orchestratorModel);
  const defaultHere = useDefaultModel();
  const startingChoice = (): AgentChoice => {
    const selected = orchestratorHere ?? defaultHere;
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
  const here = useRosterHere(models);
  const views = here.map((row) => row.entry);
  const recommendedOn = useRecommendedOn();
  const available = useAvailableModels(recommendedOn && models.some((model) => isPinned(model)));
  const fallback = defaultWorkerIndex(models);
  const checked = useWorkerModelIssues({ ...charter, workerModels: views });
  const issues: readonly WorkerModelIssue[] = here
    .map((row, index): WorkerModelIssue | undefined =>
      row.missing === undefined
        ? checked.find((each) => each.index === index)
        : {
            index,
            message: `Unavailable: ${row.missing[0]!.toUpperCase()}${row.missing.slice(1)}. A worker given it gets the default.`,
            unavailable: { fix: "workspaces" },
          },
    )
    .filter((issue) => issue !== undefined);
  const candidate = choice.model === "" ? undefined : pinnedWithUseFor(choiceModel(choice), note);
  const candidateIssue = useWorkerModelIssues({
    ...charter,
    workerModels: candidate === undefined ? views : [...views, candidate],
  }).find((issue) => candidate !== undefined && issue.index === models.length);
  const defaultAgent = defaultHere?.agent;
  const notes = harnessNotes(
    [...views, ...(orchestratorHere === undefined ? [] : [orchestratorHere])],
    defaultAgent,
  );
  const profileName = (model: ModelRef): string | undefined =>
    model.profileId === undefined
      ? undefined
      : (profiles?.find((profile) => profile.id === model.profileId)?.name ?? model.profileId);
  const followRow = (index: number): (() => void) | undefined => {
    const stored = models[index];
    if (stored === undefined || !isPinned(stored) || !available.settled) return undefined;
    const next = followOfPinned(stored, available);
    return next === undefined ? undefined : () => replace(index, next);
  };
  const replace = (index: number, next: WorkerModel) => {
    if (models.some((model, i) => i !== index && sameSlot(model, next))) return;
    onChange(
      withWorkerModels(
        charter,
        models.map((model, i) => (i === index ? next : model)),
      ),
    );
  };

  return (
    <>
      <OrchestratorModelField
        charter={charter}
        disabled={disabled}
        onChange={onChange}
        description={orchestratorDescription}
      />
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
                {views.map((model, index) => {
                  const stored = models[index]!;
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
                      data-tier={model.tier}
                      data-default={isDefault || undefined}
                      data-unavailable={issue?.unavailable === undefined ? undefined : true}
                      className={cn(
                        "flex flex-col gap-1 rounded-md border border-border p-2",
                        issue?.unavailable !== undefined && "border-dashed",
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <span className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-reading">
                          <SlotGlyph slot={modelSlotOf(stored)} />
                          <AgentIcon agent={model.agent} className="size-icon-row shrink-0" />
                          <span className="shrink-0">{agentLabel(model.agent)}</span>
                          <span className="min-w-0 font-mono text-meta break-all">
                            {model.model}
                          </span>
                          <WorkerSpeedField
                            model={model}
                            disabled={disabled}
                            onChange={(next) => replace(index, pinView({ ...next }, stored))}
                          />
                          <EffortField
                            model={model}
                            follows={isTierRef(stored)}
                            disabled={disabled}
                            onChange={(variant) =>
                              replace(
                                index,
                                isTierRef(stored)
                                  ? followAt(stored, pinView(model, stored), variant)
                                  : pinView({ ...withVariant(model, variant) }, stored),
                              )
                            }
                          />
                          {profile !== undefined && (
                            <span className="shrink-0 text-meta text-muted-foreground">
                              {profile}
                            </span>
                          )}
                          <FollowButton
                            slot={modelSlotOf(stored)}
                            disabled={disabled}
                            onFollow={followRow(index)}
                          />
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
                        model={pinView(model, stored)}
                        placeholder={
                          model.tier !== undefined && stored.useFor === undefined
                            ? model.useFor
                            : undefined
                        }
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
              className="flex flex-col gap-2 rounded-md border border-edge bg-card/40 p-2.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <AgentFields value={choice} onChange={setChoice} allowed={admitted} />
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
                          addWorkerModel(models, pinnedWithUseFor(choiceModel(choice), note)),
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
              Add a model
            </Button>
          )}
        </div>
      </Field>
    </>
  );
}
