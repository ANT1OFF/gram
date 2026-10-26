import {
  AgentKind,
  type GatewayProfile,
  type ModelRef,
  type ProfileId,
  type ReasoningVariant,
  type SpeedMode,
  modelSpeeds,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Gauge, KeyRound } from "lucide-react";
import { useEffect } from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { SpeedField } from "./speed-field";
import { ModelSelect } from "./model-select";
import { defaultModelId, effortOptions, useModels } from "./models";
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

/** The effort picker's "no explicit effort" choice. */
const DEFAULT_EFFORT = "default";

/** Every harness is offered, including when signed out. */
export function useAvailableAgents(): readonly AgentKind[] {
  return AgentKind.literals;
}

/** A profile choice meaning no gateway: the agent's own authentication. */
const SUBSCRIPTION = "subscription";

/** Local agents need no gateway; an explicit gateway choice must still exist and have a key. */
export function gatewayReady(choice: AgentChoice, profiles: readonly GatewayProfile[]): boolean {
  if (choice.profileId === undefined) return true;
  if (choice.agent === "grok") return false;
  return profiles.some((profile) => profile.id === choice.profileId && profile.keyRef !== "");
}

/** Stands in for the model picker while a gateway agent has no key to run with. */
function AddKeyNote({ agent }: { agent: AgentKind }) {
  return (
    <p className="flex h-8 items-center gap-1.5 text-xs text-muted-foreground">
      <KeyRound aria-hidden className="size-3.5 shrink-0" />
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

/**
 * The agent picker, then local authentication or an explicit gateway profile, the model, and the
 * reasoning effort once `models.list` says the model supports one.
 */
export function AgentFields({
  value,
  onChange,
  allowed,
  ghost = false,
  initializeDefault = true,
  subscriptionOnly = false,
}: {
  value: AgentChoice;
  onChange: (next: AgentChoice) => void;
  /** Only these agent kinds are offered, for a role not every agent may take; absent offers all. */
  allowed?: readonly AgentKind[] | undefined;
  /** Styled as composer toolbar controls, each with its glyph, for the `/new` hero's prompt box. */
  ghost?: boolean;
  /** Drafts resolve an empty choice; an unset saved setting may display it without saving. */
  initializeDefault?: boolean;
  /** For explicit CLI-only transitions; never offers gateway/account migration. */
  subscriptionOnly?: boolean;
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
  const needsKey =
    gateway && profilesListed && (effective === undefined || effective.keyRef === "");
  const models = useModels(value.agent, value.profileId);
  // Unlike the composer, don't offer every effort before the server has listed the models.
  // The local CLI or explicitly chosen gateway supplies its own default. Never guess an account model.
  const listedDefault = defaultModelId(models);
  const shownModel = value.model || listedDefault || "";
  const efforts = models && !needsKey ? effortOptions(models, shownModel) : [];
  const effortItems = [{ value: DEFAULT_EFFORT, label: "Default effort" }, ...efforts];
  useEffect(() => {
    if (initializeDefault && value.model === "" && listedDefault && !needsKey) {
      onChange({ ...value, model: listedDefault });
    }
  }, [value, listedDefault, needsKey, onChange, initializeDefault]);

  const agentItems = agents.map((agent) => ({ value: agent, label: agentLabel(agent) }));
  const profileItems = profiles.map((p) => ({ value: p.id, label: p.name }));

  return (
    <>
      {value.agent === "grok" && (
        <p className="text-xs text-muted-foreground">
          Grok Build is unavailable: the official CLI cannot enforce subscription-only inference
          routing. Login or a subscription purchase does not resolve this CLI limitation. Gram
          starts no Grok CLI or inference request.
        </p>
      )}
      {agents.length > 1 ? (
        <Select
          value={value.agent}
          items={agentItems}
          onValueChange={(next) => {
            if (next === null || next === value.agent) return;
            onChange({ agent: next as AgentKind, model: "", speed: "standard" });
          }}
        >
          <SelectTrigger aria-label="Agent" {...trigger}>
            <AgentIcon agent={value.agent} className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agentItems.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                <AgentIcon agent={o.value} className="size-3.5 text-muted-foreground" />
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span
          className={
            ghost
              ? "flex h-7 items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground"
              : "flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm"
          }
        >
          <AgentIcon agent={agents[0] ?? value.agent} className="size-3.5 text-muted-foreground" />
          {agentLabel(agents[0] ?? value.agent)}
        </span>
      )}
      {!subscriptionOnly && supportsGateway && profiles.length > 0 && (
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
      {!needsKey && (
        <ModelSelect
          agent={value.agent}
          {...(value.profileId === undefined ? {} : { profileId: value.profileId })}
          value={shownModel}
          ghost={ghost}
          onChange={(model) => {
            const keep =
              value.variant !== undefined &&
              (models === undefined ||
                effortOptions(models, model).some((o) => o.value === value.variant));
            onChange(
              withVariant(
                {
                  ...value,
                  model,
                  ...(value.speed === "fast" && !modelSpeeds(models, model).includes("fast")
                    ? { speed: "standard" as const }
                    : {}),
                },
                keep ? value.variant : undefined,
              ),
            );
          }}
        />
      )}
      {supportsGateway && !needsKey && (
        <SpeedField
          agent={value.agent}
          model={shownModel}
          models={models}
          value={value.speed}
          onChange={(speed) => onChange({ ...value, speed })}
          ghost={ghost}
        />
      )}
      {efforts.length > 0 && (
        <Select
          value={value.variant ?? DEFAULT_EFFORT}
          items={effortItems}
          onValueChange={(next) => {
            if (next === null) return;
            onChange(
              withVariant(value, next === DEFAULT_EFFORT ? undefined : (next as ReasoningVariant)),
            );
          }}
        >
          <SelectTrigger aria-label="Effort" {...trigger}>
            {ghost && <Gauge aria-hidden className="size-3.5" />}
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {effortItems.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </>
  );
}
