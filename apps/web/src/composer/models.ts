import {
  CUSTOM_MODEL_DESCRIPTION,
  GATEWAY_UNLISTED_WARNING,
  listedRow,
  supersededModels,
  type AgentKind,
  type AgentModel,
  type ModelRef,
  type ProfileId,
  type ReasoningVariant,
} from "@gram/contracts";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { agentLabel } from "@/agents/agent-label";
import { useApi } from "@/api/context";

import { DEFAULT_MODEL_OPTIONS, EFFORT_OPTIONS } from "./options";
import type { PickerOption } from "./picker";

/**
 * `models.list` for an agent, through `profileId` for a gateway agent; `undefined` until it resolves
 * or while the server lacks it.
 */
export function useModelsQuery(agent: AgentKind, profileId?: ProfileId, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["models", agent, profileId ?? null],
    queryFn: () =>
      profileId === undefined ? api.listModels(agent) : api.listModels(agent, profileId),
    retry: false,
    // A failed discovery stays actionable when a chooser mounts; its Retry owns the next probe.
    retryOnMount: false,
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useModels(
  agent: AgentKind,
  profileId?: ProfileId,
): readonly AgentModel[] | undefined {
  const query = useModelsQuery(agent, profileId);
  return query.isError ? undefined : query.data?.models;
}

/**
 * `useModels` with the one thing it can't say: whether the question has been answered. `undefined`
 * models mean "still asking" while `settled` is false and "the agent couldn't say" once it is true,
 * which a caller deciding what NOT to show has to tell apart.
 */
export function useModelsSettled(
  agent: AgentKind,
  enabled = true,
  profileId?: ProfileId,
): {
  readonly models: readonly AgentModel[] | undefined;
  readonly settled: boolean;
} {
  const { data, isPending, isError, isFetched } = useModelsQuery(agent, profileId, enabled);
  // Retrying an initial error becomes pending again, but must not unmount the retrying chooser.
  return { models: isError ? undefined : data?.models, settled: !isPending || isFetched };
}

/**
 * The picker's id for a thread's or roster entry's model: the catalogue row it names (an alias,
 * the pinned id an alias row runs, or its display name; `resolveModel`), else the id as stored. A
 * thread stored on `claude-fable-5-2` shows, with its check and efforts, as the `fable` row
 * while the agent says `fable` runs that id.
 */
export const pickerModelId = (
  models: readonly AgentModel[] | undefined,
  id: string | undefined,
): string | undefined => (id === undefined ? undefined : (listedRow(models, id)?.id ?? id));

/**
 * A model's name as the composer's picker shows it: the agent's own display name for the model
 * (`pickerModelId`), else the built-in Claude name, else the id itself ("opus" reads "Claude Opus"
 * wherever it is named).
 */
export const modelDisplayName = (
  models: readonly AgentModel[] | undefined,
  agent: AgentKind,
  id: string,
): string =>
  listedRow(models, id)?.displayName ??
  (agent === "claude" ? DEFAULT_MODEL_OPTIONS.find((o) => o.value === id)?.label : undefined) ??
  id;

/**
 * `modelDisplayName` for every model in `refs`, from the same `models.list` answers the composer's
 * picker reads (one per agent and gateway profile), so a form names a model as the composer does.
 */
export function useModelNames(refs: readonly (ModelRef | undefined)[]): (ref: ModelRef) => string {
  const api = useApi();
  const keys = [
    ...new Map(
      refs.flatMap((ref) =>
        ref === undefined ? [] : [[`${ref.agent}:${ref.profileId ?? ""}`, ref] as const],
      ),
    ).values(),
  ];
  const results = useQueries({
    queries: keys.map((ref) => ({
      queryKey: ["models", ref.agent, ref.profileId ?? null],
      queryFn: () =>
        ref.profileId === undefined
          ? api.listModels(ref.agent)
          : api.listModels(ref.agent, ref.profileId),
      retry: false,
      retryOnMount: false,
      staleTime: 5 * 60_000,
    })),
  });
  return (ref) => {
    const index = keys.findIndex(
      (each) => each.agent === ref.agent && (each.profileId ?? "") === (ref.profileId ?? ""),
    );
    const models = index === -1 ? undefined : results[index]?.data?.models;
    return modelDisplayName(models, ref.agent, ref.model);
  };
}

/**
 * Asks `models.list` again for an agent if what the UI holds is stale, as a picker opens, so a model
 * the account gained or lost since shows without a reload.
 */
export function useRefreshModels(agent: AgentKind, profileId?: ProfileId): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.refetchQueries({
      queryKey: ["models", agent, profileId ?? null],
      stale: true,
    });
  }, [queryClient, agent, profileId]);
}

/**
 * The model picker's section for what `agent` lists through `profileId`: the agent's name on the
 * user's own subscription, else the gateway profile's.
 */
export function useProviderLabel(agent: AgentKind, profileId: ProfileId | undefined): string {
  const api = useApi();
  const { data: profiles } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
    enabled: profileId !== undefined,
  });
  if (profileId === undefined) return agentLabel(agent);
  return profiles?.find((profile) => profile.id === profileId)?.name ?? "Gateway";
}

/** What the picker says of a thread's model its gateway doesn't offer (or no longer does). */
export const NOT_LISTED_BY_GATEWAY = GATEWAY_UNLISTED_WARNING;

/**
 * What the picker says of a Claude thread's model the user's own Claude account doesn't list (or no
 * longer does). "May", since an early-access id the account takes is never listed.
 */
export const NOT_LISTED_BY_ACCOUNT = "Not offered by your Claude account; it may not work";
export const NOT_LISTED_BY_CODEX = "Not listed by your Codex account; it may not work";

/** `[1m]` names a model's long-context variant, which runs the same model. */
const baseId = (id: string) => id.replace(/\[1m\]$/i, "");

/**
 * Whether `models` offers `id`: a row it names (`pickerModelId`), or for a row naming the id it
 * resolves to (Claude Code's aliases), that id or either one's long-context variant.
 */
const isOffered = (models: readonly AgentModel[], id: string): boolean =>
  listedRow(models, id) !== undefined ||
  models.some(
    (m) =>
      m.id === id ||
      (m.resolvedId !== undefined &&
        (baseId(m.id) === baseId(id) || baseId(m.resolvedId) === baseId(id))),
  );

/** The model picker's amber warning for a Claude thread its account doesn't list the model of. */
export const accountModelWarning = (
  models: readonly AgentModel[] | undefined,
  modelId: string | undefined,
): string | undefined =>
  models === undefined || modelId === undefined || isOffered(models, modelId)
    ? undefined
    : NOT_LISTED_BY_ACCOUNT;

/** What the picker warns of a model the list lacks: the gateway's word, or the Claude account's. */
export const unlistedWarning = (
  agent: AgentKind,
  profileId: ProfileId | undefined,
): string | undefined =>
  profileId !== undefined
    ? NOT_LISTED_BY_GATEWAY
    : agent === "claude"
      ? NOT_LISTED_BY_ACCOUNT
      : agent === "codex"
        ? NOT_LISTED_BY_CODEX
        : undefined;

/** The section a model the user added in Settings lists under, past the agents' own. */
export const CUSTOM_GROUP = "Custom";

/**
 * Picker options from the server's models, else `fallback` (the built-in Claude list); always
 * includes `current`, described as `unlisted` when the server's models lack it, unless it names
 * one of their rows another way (`pickerModelId`), which then stands for it. A model's warning
 * stands in for its description. With `group` (the agent or gateway the list comes from), each
 * option lists under it, and a model added in Settings under `CUSTOM_GROUP`.
 */
export function modelOptions(
  models: readonly AgentModel[] | undefined,
  current: string | undefined,
  fallback: readonly PickerOption<string>[] = DEFAULT_MODEL_OPTIONS,
  unlisted?: string,
  group?: string,
): PickerOption<string>[] {
  const inGroup = (custom: boolean) =>
    group === undefined ? {} : { group: custom ? CUSTOM_GROUP : group };
  const superseded = models === undefined ? undefined : supersededModels(models);
  const options: PickerOption<string>[] = models
    ? models.map((m) => {
        const description = m.warning ?? m.description;
        return {
          value: m.id,
          label: m.displayName,
          ...(description ? { description } : {}),
          ...inGroup(m.description === CUSTOM_MODEL_DESCRIPTION && m.warning === undefined),
          // The model a thread or entry is on stays in view, superseded or not.
          ...(superseded?.has(m.id) === true && m.id !== current ? { legacy: true } : {}),
        };
      })
    : fallback.map((option) => ({ ...option, ...inGroup(false) }));
  if (current && !options.some((o) => o.value === current) && !listedRow(models, current)) {
    options.push({
      value: current,
      label: current,
      ...(models && unlisted !== undefined && !isOffered(models, current)
        ? { description: unlisted }
        : {}),
      ...inGroup(false),
    });
  }
  return options;
}

/**
 * What to warn about a gateway thread's model, for the model picker's amber tint: that the gateway
 * doesn't offer it, or the agent's own warning. Nothing while the models are still loading.
 */
export const gatewayModelWarning = (
  models: readonly AgentModel[] | undefined,
  modelId: string | undefined,
): string | undefined => {
  if (!models || modelId === undefined) return undefined;
  const model = listedRow(models, modelId);
  return model === undefined ? NOT_LISTED_BY_GATEWAY : model.warning;
};

/** Why an effort for a model its gateway lists none for is offered anyway, for a tooltip. */
export const UNLISTED_EFFORTS =
  "The gateway doesn't list efforts for this model; it may ignore or reject one";

/**
 * The efforts `modelId` supports; every effort while the server hasn't listed models, and the ones
 * the server offers, each labelled as not listed, for a model whose gateway lists none.
 */
export function effortOptions(
  models: readonly AgentModel[] | undefined,
  modelId: string | undefined,
): readonly PickerOption<ReasoningVariant>[] {
  if (!models) return EFFORT_OPTIONS;
  const model = listedRow(models, modelId);
  if (!model?.supportsEffort) return [];
  const efforts = model.efforts;
  const offered = efforts
    ? EFFORT_OPTIONS.filter((o) => efforts.includes(o.value))
    : EFFORT_OPTIONS;
  return model.effortsUnlisted
    ? offered.map((o) => ({ ...o, label: `${o.label} (not listed)` }))
    : offered;
}

/**
 * The effort a thread keeps on switching to `modelId`: its current one while the new model offers
 * it, else none, so the model's own default applies rather than an effort it may reject.
 */
export const effortAfterSwitch = (
  models: readonly AgentModel[] | undefined,
  modelId: string,
  variant: ReasoningVariant | undefined,
): ReasoningVariant | undefined =>
  variant !== undefined && effortOptions(models, modelId).some((o) => o.value === variant)
    ? variant
    : undefined;

/** Whether the gateway `modelId` runs on lists no efforts for it (see `effortOptions`). */
export const effortsUnlisted = (
  models: readonly AgentModel[] | undefined,
  modelId: string | undefined,
): boolean => listedRow(models, modelId)?.effortsUnlisted === true;

/** The model `models.list` marks as default, else the first. */
export const defaultModelId = (models: readonly AgentModel[] | undefined): string | undefined =>
  (models?.find((m) => m.isDefault) ?? models?.[0])?.id;

/** Past this many models a Settings model picker searches; the composer's always does. */
export const MODEL_SEARCH_THRESHOLD = 8;

export interface ModelGroup {
  readonly label: string;
  readonly items: readonly PickerOption<string>[];
}

/** The section of an option without a `group`, and the whole list's when no option has one. */
const UNGROUPED = "Models";

/** The searching picker's last section: the models a newer one of their family supersedes. */
export const LEGACY_GROUP = "Legacy models";

/** How many of `options` the picker folds under Legacy models: superseded, and not starred. */
export const legacyCount = (
  options: readonly PickerOption<string>[],
  favourite: (value: string) => boolean,
): number => options.filter((option) => option.legacy === true && !favourite(option.value)).length;

/**
 * The searching picker's sections: favourites first, then the rest by their `group` (the agent or
 * gateway, or Custom), each section where its first model is in the list, in the list's order.
 * Without groups the rest are one section, "Other models" below favourites. A superseded model
 * that isn't a favourite (`legacy`) is left out, or with `legacyShown` listed last under
 * `LEGACY_GROUP`.
 */
export function modelGroups(
  options: readonly PickerOption<string>[],
  favourite: (value: string) => boolean,
  legacyShown = true,
): ModelGroup[] {
  const starred = options.filter((option) => favourite(option.value));
  const unstarred = options.filter((option) => !favourite(option.value));
  const legacy = unstarred.filter((option) => option.legacy === true);
  const rest = unstarred.filter((option) => option.legacy !== true);
  const grouped = options.some((option) => option.group !== undefined);
  const sections = new Map<string, PickerOption<string>[]>();
  for (const option of rest) {
    const label = grouped
      ? (option.group ?? UNGROUPED)
      : starred.length > 0
        ? "Other models"
        : UNGROUPED;
    const section = sections.get(label);
    if (section) section.push(option);
    else sections.set(label, [option]);
  }
  return [
    ...(starred.length > 0 ? [{ label: "Favourites", items: starred }] : []),
    ...[...sections].map(([label, items]) => ({ label, items })),
    ...(legacyShown && legacy.length > 0 ? [{ label: LEGACY_GROUP, items: legacy }] : []),
  ];
}

/**
 * Whether every word of `query` is in the model's name, id, description or group (its agent or
 * gateway), ignoring case.
 */
export function matchesModel(option: PickerOption<string>, query: string): boolean {
  const haystack =
    `${option.label} ${option.value} ${option.description ?? ""} ${option.group ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}
