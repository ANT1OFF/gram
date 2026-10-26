import {
  GATEWAY_UNLISTED_WARNING,
  type AgentKind,
  type AgentModel,
  type ProfileId,
  type ReasoningVariant,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

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
 * Whether `models` offers `id`: a row of that id, or for a row naming the id it resolves to (Claude
 * Code's aliases), that id or either one's long-context variant.
 */
const isOffered = (models: readonly AgentModel[], id: string): boolean =>
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

/**
 * Picker options from the server's models, else `fallback` (the built-in Claude list); always
 * includes `current`, described as `unlisted` when the server's models lack it. A model's warning
 * stands in for its description.
 */
export function modelOptions(
  models: readonly AgentModel[] | undefined,
  current: string | undefined,
  fallback: readonly PickerOption<string>[] = DEFAULT_MODEL_OPTIONS,
  unlisted?: string,
): PickerOption<string>[] {
  const options: PickerOption<string>[] = models
    ? models.map((m) => {
        const description = m.warning ?? m.description;
        return { value: m.id, label: m.displayName, ...(description ? { description } : {}) };
      })
    : [...fallback];
  if (current && !options.some((o) => o.value === current)) {
    options.push({
      value: current,
      label: current,
      ...(models && unlisted !== undefined && !isOffered(models, current)
        ? { description: unlisted }
        : {}),
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
  const model = models.find((m) => m.id === modelId);
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
  const model = models.find((m) => m.id === modelId);
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
): boolean => models?.find((m) => m.id === modelId)?.effortsUnlisted === true;

/** The model `models.list` marks as default, else the first. */
export const defaultModelId = (models: readonly AgentModel[] | undefined): string | undefined =>
  (models?.find((m) => m.isDefault) ?? models?.[0])?.id;

/** Past this many models the composer's model picker searches, and offers favourites. */
export const MODEL_SEARCH_THRESHOLD = 8;

export interface ModelGroup {
  readonly label: string;
  readonly items: readonly PickerOption<string>[];
}

/** The searching picker's sections: favourites first, then the rest, each in the list's order. */
export function modelGroups(
  options: readonly PickerOption<string>[],
  favourite: (value: string) => boolean,
): ModelGroup[] {
  const starred = options.filter((option) => favourite(option.value));
  const rest = options.filter((option) => !favourite(option.value));
  if (starred.length === 0) return [{ label: "Models", items: rest }];
  return [
    { label: "Favourites", items: starred },
    ...(rest.length > 0 ? [{ label: "Other models", items: rest }] : []),
  ];
}

/** Whether every word of `query` is in the model's name, id or description, ignoring case. */
export function matchesModel(option: PickerOption<string>, query: string): boolean {
  const haystack = `${option.label} ${option.value} ${option.description ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}
