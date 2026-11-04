import type { AgentKind, ProfileId } from "@gram/contracts";
import { useMutation, useQueries } from "@tanstack/react-query";
import { useState } from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { useLaunchChecks } from "@/launch-checks/use-launch-checks";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useIsFavourite, useIsFavouriteOf, useModelFavourites } from "./model-favourites";
import { ModelCombobox } from "./model-picker";
import {
  CUSTOM_GROUP,
  MODEL_SEARCH_THRESHOLD,
  modelOptions,
  unlistedWarning,
  useModelsQuery,
  useProviderLabel,
  useRefreshModels,
} from "./models";
import type { PickerOption } from "./picker";
import { GHOST_TRIGGER } from "./styles";

/** Where a model in the prompt box's list runs: an agent, through a gateway or its own account. */
export interface ModelPick {
  readonly agent: AgentKind;
  readonly profileId?: ProfileId;
  readonly model: string;
}

/** A row of the prompt box's list, unique across agents and gateways. */
const pickKey = (agent: AgentKind, profileId: ProfileId | undefined, model: string) =>
  JSON.stringify([agent, profileId ?? null, model]);

const parsePick = (key: string): ModelPick => {
  const [agent, profileId, model] = JSON.parse(key) as [AgentKind, ProfileId | null, string];
  return profileId === null ? { agent, model } : { agent, profileId, model };
};

/** `options` of `agent` through `profileId`, keyed for the prompt box's list and marked. */
const keyed = (
  agent: AgentKind,
  profileId: ProfileId | undefined,
  options: readonly PickerOption<string>[],
) =>
  options.map((option) => ({
    ...option,
    value: pickKey(agent, profileId, option.value),
    icon: <AgentIcon agent={agent} className="size-3.5" />,
  }));

/**
 * The prompt box's model list across `agents`: each agent's own models under its name, then every
 * model added in Settings under Custom, then the chosen gateway's models under its name. Each row
 * carries its agent's mark. Another agent's models are asked for only while `open`.
 */
function useModelsAcross(
  agents: readonly AgentKind[],
  current: { agent: AgentKind; profileId?: ProfileId | undefined },
  currentOptions: readonly PickerOption<string>[],
  open: boolean,
): PickerOption<string>[] {
  const api = useApi();
  // The same queries `useModelsQuery` makes, so the lists the draft already fetched are reused. An
  // agent the draft isn't on is asked only once the list opens, never just for showing the form.
  const listings = useQueries({
    queries: agents.map((agent) => ({
      enabled: open || (agent === current.agent && current.profileId === undefined),
      queryKey: ["models", agent, null],
      queryFn: () => api.listModels(agent),
      retry: false,
      retryOnMount: false,
      staleTime: 5 * 60_000,
    })),
  });
  const own: PickerOption<string>[] = [];
  const custom: PickerOption<string>[] = [];
  agents.forEach((agent, index) => {
    const onAccount = agent === current.agent && current.profileId === undefined;
    const listed = onAccount
      ? currentOptions
      : modelOptions(listings[index]?.data?.models, undefined, [], undefined, agentLabel(agent));
    for (const row of keyed(agent, undefined, listed))
      (row.group === CUSTOM_GROUP ? custom : own).push(row);
  });
  const gateway =
    current.profileId === undefined || !agents.includes(current.agent)
      ? []
      : keyed(current.agent, current.profileId, currentOptions);
  return [...own, ...custom, ...gateway];
}

/**
 * The model picker for drafts and Settings, fed by `models.list` (a gateway agent's models come
 * from `profileId`). In the prompt box (`ghost`) it is the composer's searching list with
 * favourites, and with `onPick` every one of `agents`' models is in it, picking another agent's or
 * gateway's switching to it; elsewhere it searches past `MODEL_SEARCH_THRESHOLD` models.
 */
export function ModelSelect({
  agent,
  profileId,
  value,
  onChange,
  ghost = false,
  agents,
  onPick,
}: {
  agent: AgentKind;
  profileId?: ProfileId;
  value: string;
  onChange: (model: string) => void;
  /** Styled as a composer toolbar control, for the `/new` hero's prompt box. */
  ghost?: boolean;
  /** The agents whose models the prompt box lists beside `agent`'s; only with `onPick`. */
  agents?: readonly AgentKind[] | undefined;
  /** Called for a model of another agent or gateway than `agent` and `profileId`. */
  onPick?: ((pick: ModelPick) => void) | undefined;
}) {
  const listing = useModelsQuery(agent, profileId);
  const provider = useProviderLabel(agent, profileId);
  // CLI aliases are a fallback only for local Claude, never for a gateway or another account.
  const options = modelOptions(
    listing.data?.models,
    value,
    agent === "claude" && profileId === undefined ? undefined : [],
    unlistedWarning(agent, profileId),
    provider,
  );
  const across = onPick !== undefined && agents !== undefined;
  const refresh = useRefreshModels(agent, profileId);
  const [open, setOpenState] = useState(false);
  const acrossOptions = useModelsAcross(across ? agents : [], { agent, profileId }, options, open);
  const setOpen = (next: boolean) => {
    if (next) refresh();
    setOpenState(next);
  };
  const favourite = useIsFavourite(agent);
  const favouriteOf = useIsFavouriteOf();
  const { recheck } = useLaunchChecks();
  const retry = useMutation({
    mutationFn: async () => {
      // A CLI login performed outside Gram may leave its discovery server holding old auth.
      if (profileId === undefined) await recheck();
      else await listing.refetch();
    },
  });
  if (listing.isPending && value === "")
    return (
      <span role="status" className="text-xs text-muted-foreground">
        Loading models…
      </span>
    );
  if (listing.isError)
    return (
      <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
        <span>{errorMessage(listing.error)}</span>
        {retry.isError && <span>{errorMessage(retry.error)}</span>}
        <Button size="sm" variant="ghost" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? "Retrying…" : "Retry models"}
        </Button>
      </div>
    );
  if (across) {
    return (
      <ModelCombobox
        label="Model"
        value={pickKey(agent, profileId, value)}
        options={acrossOptions}
        onChange={(key) => {
          const pick = parsePick(key);
          if (pick.agent === agent && pick.profileId === profileId) onChange(pick.model);
          else onPick(pick);
        }}
        open={open}
        onOpenChange={setOpen}
        // The agent picker beside it carries the mark.
        icon={undefined}
        title="Model"
        description={undefined}
        labelled
        favourite={(key) => {
          const pick = parsePick(key);
          return favouriteOf(pick.agent, pick.model);
        }}
        onToggleFavourite={(key) => {
          const pick = parsePick(key);
          useModelFavourites.getState().toggle(pick.agent, pick.model);
        }}
      />
    );
  }
  if (ghost || options.length > MODEL_SEARCH_THRESHOLD) {
    return (
      <ModelCombobox
        label="Model"
        value={value}
        options={options}
        onChange={onChange}
        open={open}
        onOpenChange={setOpen}
        icon={undefined}
        rowIcon={<AgentIcon agent={agent} className="size-3.5" />}
        title="Model"
        description={undefined}
        labelled
        favourite={favourite}
        onToggleFavourite={(model) => useModelFavourites.getState().toggle(agent, model)}
        field={!ghost}
      />
    );
  }
  return (
    <Select
      value={value}
      items={options}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger
        aria-label="Model"
        {...(ghost ? { size: "sm" as const, className: GHOST_TRIGGER } : {})}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
