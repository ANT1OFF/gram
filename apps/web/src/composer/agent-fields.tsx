import {
  aboveHigh,
  AgentKind,
  type AgentModel,
  type GatewayProfile,
  type ModelRef,
  type ProfileId,
  type ReasoningVariant,
  type SpeedMode,
  modelSpeeds,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { useEffect } from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { effortSection, speedSection } from "./choice-sections";
import { ComposerChoices, type ChoiceSection } from "./choices";
import { SpeedField } from "./speed-field";
import { ModelSelect, useModelSection, type ModelPick } from "./model-select";
import type { PickerOption } from "./picker";
import { PickerTrigger } from "./picker-trigger";
import { defaultModelId, effortOptions, useModels } from "./models";
import { DEFAULT_EFFORT, DEFAULT_EFFORT_OPTION } from "./options";
import { GHOST_TRIGGER } from "./styles";

/** What a new thread runs on; `profileId` only when the user explicitly selects a gateway. */
export interface AgentChoice {
  readonly agent: AgentKind;
  readonly model: string;
  readonly profileId?: ProfileId;
  /** The reasoning effort, when the model supports one; absent means the model's default. */
  readonly variant?: ReasoningVariant;
  readonly speed?: SpeedMode;
}

/** `choice` with `variant`, or without one. */
const withVariant = (choice: AgentChoice, variant: ReasoningVariant | undefined): AgentChoice => ({
  agent: choice.agent,
  model: choice.model,
  ...(choice.profileId === undefined ? {} : { profileId: choice.profileId }),
  ...(variant === undefined ? {} : { variant }),
  ...(choice.speed === undefined ? {} : { speed: choice.speed }),
});

/** The `ModelRef` a choice starts a thread on. */
export const choiceModel = (choice: AgentChoice): ModelRef => withVariant(choice, choice.variant);

/** Every harness is offered, including when signed out. */
export function useAvailableAgents(): readonly AgentKind[] {
  return AgentKind.literals;
}

/** A profile choice meaning no gateway: the agent's own authentication. */
const SUBSCRIPTION = "subscription";

/** Local agents need no gateway; an explicit gateway choice must still exist and have a key. */
export function gatewayReady(choice: AgentChoice, profiles: readonly GatewayProfile[]): boolean {
  if (choice.profileId === undefined) return true;
  return profiles.some((profile) => profile.id === choice.profileId && profile.keyRef !== "");
}

/** Stands in for the model picker while a gateway agent has no key to run with. */
function AddKeyNote({ agent }: { agent: AgentKind }) {
  return (
    <p className="flex h-8 items-center gap-1.5 text-meta text-muted-foreground">
      <KeyRound aria-hidden className="size-icon-row shrink-0" />
      {`${agentLabel(agent)} runs through your gateway.`}
      <Link
        to="/settings/gateways"
        className="font-medium text-foreground underline underline-offset-2"
      >
        Add your gateway key
      </Link>
    </p>
  );
}

/** `value` on `model`, keeping its effort and Fast only where the new model offers them. */
const onModel = (
  value: AgentChoice,
  models: readonly AgentModel[] | undefined,
  model: string,
): AgentChoice => {
  const keep =
    value.variant !== undefined &&
    (models === undefined || effortOptions(models, model).some((o) => o.value === value.variant));
  return withVariant(
    {
      ...value,
      model,
      ...(value.speed === "fast" && !modelSpeeds(models, model).includes("fast")
        ? { speed: "standard" as const }
        : {}),
    },
    keep ? value.variant : undefined,
  );
};

/** Under a following slot's effort menu, which ends at high. */
export const FOLLOW_EFFORT_NOTE = "Ends at High while it follows";

/**
 * The prompt box's choices: one chip and its popover, as in a thread's composer (`ComposerChoices`),
 * with every agent's models in its Model section, picking another agent's switching to it. The agent
 * picker before it carries the agent's mark.
 */
function PromptBoxChoices({
  value,
  onChange,
  agents,
  subscriptionOnly,
  needsKey,
  models,
  shownModel,
  efforts,
  mode,
  onPicked,
}: {
  value: AgentChoice;
  onChange: (next: AgentChoice) => void;
  agents: readonly AgentKind[];
  subscriptionOnly: boolean;
  needsKey: boolean;
  models: readonly AgentModel[] | undefined;
  shownModel: string;
  efforts: readonly PickerOption<string>[];
  mode: ChoiceSection | undefined;
  onPicked: ((words: string) => void) | undefined;
}) {
  const model = useModelSection({
    agent: value.agent,
    profileId: value.profileId,
    value: shownModel,
    onChange: (next) => onChange(onModel(value, models, next)),
    ...(subscriptionOnly
      ? {}
      : {
          agents,
          onPick: (pick: ModelPick) =>
            onChange({
              agent: pick.agent,
              model: pick.model,
              speed: "standard",
              ...(pick.profileId === undefined ? {} : { profileId: pick.profileId }),
            }),
        }),
  });
  // With no key there is no model to run: the note beside says so, and only the mode is left.
  // While the models load or fail, their status stands in the model's place, as it says why.
  const sections: ChoiceSection[] = needsKey
    ? mode === undefined
      ? []
      : [mode]
    : [
        ...(model.section === undefined ? [] : [model.section]),
        effortSection({
          efforts,
          value: value.variant,
          onChange: (next) =>
            onChange(
              withVariant(value, next === DEFAULT_EFFORT ? undefined : (next as ReasoningVariant)),
            ),
        }),
        ...(mode === undefined ? [] : [mode]),
        speedSection({
          agent: value.agent,
          models,
          model: shownModel,
          value: value.speed,
          onChange: (speed) => onChange({ ...value, speed }),
        }),
      ];
  return (
    <>
      {!needsKey && model.status !== undefined && (
        // It may be a sentence (an embedding app's words for nothing to pick): in a narrow prompt
        // box it wraps within the box's width and is not cut at its edge.
        <div className="flex max-w-full min-w-0 items-center">{model.status}</div>
      )}
      {sections.length > 0 && (
        <ComposerChoices
          sections={sections}
          onOpen={model.onOpen}
          onClose={model.onClose}
          onPicked={onPicked}
        />
      )}
    </>
  );
}

/**
 * The agent picker, then local authentication or an explicit gateway profile once a gateway can be
 * used, the model, its speed, and the reasoning effort once `models.list` says the model supports
 * one.
 */
export function AgentFields({
  value,
  onChange,
  allowed,
  ghost = false,
  initializeDefault = true,
  subscriptionOnly = false,
  mode,
  onPicked,
  follows = false,
}: {
  value: AgentChoice;
  onChange: (next: AgentChoice) => void;
  /**
   * The slot follows the recommended setup: its effort menu ends at high, since nothing that
   * follows goes past it. A pinned slot offers every effort the model lists.
   */
  follows?: boolean;
  /** Only these agent kinds are offered, for a role not every agent may take; absent offers all. */
  allowed?: readonly AgentKind[] | undefined;
  /**
   * The `/new` hero's prompt box: after the agent picker, model, effort, mode and speed are one
   * choices chip, as in a thread's composer.
   */
  ghost?: boolean;
  /** Drafts resolve an empty choice; an unset saved setting may display it without saving. */
  initializeDefault?: boolean;
  /** For explicit CLI-only transitions; never offers gateway/account migration. */
  subscriptionOnly?: boolean;
  /** The prompt box's mode, its section between effort and speed. */
  mode?: ChoiceSection | undefined;
  /** In the prompt box, told each pick in words, to confirm it. */
  onPicked?: ((words: string) => void) | undefined;
}) {
  const trigger = ghost ? { size: "sm" as const, className: GHOST_TRIGGER } : {};
  const api = useApi();
  const available = useAvailableAgents();
  const agents = allowed === undefined ? available : available.filter((a) => allowed.includes(a));
  const supportsGateway = value.agent === "claude" || value.agent === "codex";
  const gateway = supportsGateway && value.profileId !== undefined;
  const { data: profiles = [], isSuccess: profilesListed } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });
  const effective = profiles.find((profile) => profile.id === value.profileId);
  // Subscription is only worth a picker beside another way in: a gateway with a key, or the one
  // already chosen, which the picker leaves by.
  const pickAuth = gateway || profiles.some((profile) => profile.keyRef !== "");
  const needsKey =
    gateway && profilesListed && (effective === undefined || effective.keyRef === "");
  const models = useModels(value.agent, value.profileId);
  // Unlike the composer, don't offer every effort before the server has listed the models.
  // The local CLI or explicitly chosen gateway supplies its own default. Never guess an account model.
  const listedDefault = defaultModelId(models);
  const shownModel = value.model || listedDefault || "";
  const listedEfforts = models && !needsKey ? effortOptions(models, shownModel) : [];
  const efforts = follows
    ? listedEfforts.filter((option) => !aboveHigh(option.value))
    : listedEfforts;
  const effortItems = [DEFAULT_EFFORT_OPTION, ...efforts];
  useEffect(() => {
    if (initializeDefault && value.model === "" && listedDefault && !needsKey) {
      onChange({ ...value, model: listedDefault });
    }
  }, [value, listedDefault, needsKey, onChange, initializeDefault]);

  const agentItems = agents.map((agent) => ({ value: agent, label: agentLabel(agent) }));
  const profileItems = profiles.map((p) => ({ value: p.id, label: p.name }));

  return (
    <>
      {agents.length > 1 ? (
        <Select
          value={value.agent}
          items={agentItems}
          onValueChange={(next) => {
            if (next === null || next === value.agent) return;
            onChange({ agent: next as AgentKind, model: "", speed: "standard" });
          }}
        >
          {ghost ? (
            // The prompt box's composer row is icons with their words on hover: the agent's mark,
            // its name in the tooltip and read with the picker's value.
            <Hint
              label={`Agent: ${agentLabel(value.agent)}`}
              render={<SelectTrigger aria-label="Agent" {...trigger} />}
            >
              <AgentIcon agent={value.agent} className="size-icon-bar" />
              <SelectValue className="sr-only" />
            </Hint>
          ) : (
            <SelectTrigger aria-label="Agent" {...trigger}>
              <AgentIcon agent={value.agent} className="size-icon-bar" />
              <SelectValue />
            </SelectTrigger>
          )}
          <SelectContent>
            {agentItems.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                <AgentIcon agent={o.value} className="size-icon-row text-muted-foreground" />
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : ghost ? (
        // The one agent there is, as its mark alone; its name on hover and focus, so the keyboard
        // reaches the words too, and as its name to a screen reader.
        <Hint
          label={agentLabel(agents[0] ?? value.agent)}
          render={
            <span
              role="img"
              tabIndex={0}
              aria-label={agentLabel(agents[0] ?? value.agent)}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none focus-visible:focus-ring"
            />
          }
        >
          <AgentIcon agent={agents[0] ?? value.agent} className="size-icon-bar" />
        </Hint>
      ) : (
        <span className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-reading">
          <AgentIcon
            agent={agents[0] ?? value.agent}
            className="size-icon-row text-muted-foreground"
          />
          {agentLabel(agents[0] ?? value.agent)}
        </span>
      )}
      {!subscriptionOnly && supportsGateway && pickAuth && (
        <Select
          value={value.profileId ?? SUBSCRIPTION}
          items={[
            {
              value: SUBSCRIPTION,
              label: "Subscription",
            },
            ...profileItems,
          ]}
          onValueChange={(next) => {
            if (next === null || next === (value.profileId ?? SUBSCRIPTION)) return;
            const profile = profiles.find((p) => p.id === next);
            onChange({
              agent: value.agent,
              model: "",
              speed: "standard",
              ...(profile === undefined ? {} : { profileId: profile.id }),
            });
          }}
        >
          <SelectTrigger aria-label="Gateway profile" {...trigger}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[
              {
                value: SUBSCRIPTION,
                label: "Subscription",
              },
              ...profileItems,
            ].map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {needsKey && <AddKeyNote agent={value.agent} />}
      {ghost ? (
        <PromptBoxChoices
          value={value}
          onChange={onChange}
          agents={agents}
          subscriptionOnly={subscriptionOnly}
          needsKey={needsKey}
          models={models}
          shownModel={shownModel}
          efforts={efforts}
          mode={mode}
          onPicked={onPicked}
        />
      ) : (
        <>
          {!needsKey && (
            <ModelSelect
              agent={value.agent}
              {...(value.profileId === undefined ? {} : { profileId: value.profileId })}
              value={shownModel}
              onChange={(model) => onChange(onModel(value, models, model))}
            />
          )}
          {supportsGateway && !needsKey && (
            <SpeedField
              agent={value.agent}
              model={shownModel}
              models={models}
              value={value.speed}
              onChange={(speed) => onChange({ ...value, speed })}
            />
          )}
          {efforts.length > 0 && (
            <Select
              value={value.variant ?? DEFAULT_EFFORT}
              items={effortItems}
              onValueChange={(next) => {
                if (next === null) return;
                onChange(
                  withVariant(
                    value,
                    next === DEFAULT_EFFORT ? undefined : (next as ReasoningVariant),
                  ),
                );
              }}
            >
              <PickerTrigger
                label="Effort"
                value={
                  effortItems.find((o) => o.value === (value.variant ?? DEFAULT_EFFORT))?.short ??
                  DEFAULT_EFFORT_OPTION.short
                }
                labelled={false}
                field
              />
              <SelectContent>
                {effortItems.map((o) => (
                  <SelectItem key={o.value} value={o.value} description={o.description}>
                    {o.label}
                  </SelectItem>
                ))}
                {follows && (
                  <>
                    <SelectSeparator />
                    <div
                      data-testid="follow-effort-note"
                      className="px-2 py-1 text-meta text-muted-foreground"
                    >
                      {FOLLOW_EFFORT_NOTE}
                    </div>
                  </>
                )}
              </SelectContent>
            </Select>
          )}
        </>
      )}
    </>
  );
}
