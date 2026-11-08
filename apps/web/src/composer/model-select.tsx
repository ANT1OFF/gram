import type { AgentKind, ProfileId } from "@gram/contracts";
import { useMutation, useQueries } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

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
import { modelSection } from "./choice-sections";
import type { ChoiceSection } from "./choices";

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
    icon: <AgentIcon agent={agent} className="size-icon-row" />,
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

/** A model list's state: loading before it has anything to show, or failed with a retry. */
function useModelListing(agent: AgentKind, profileId: ProfileId | undefined, value: string) {
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
  const refresh = useRefreshModels(agent, profileId);
  const { recheck } = useLaunchChecks();
  const retry = useMutation({
    mutationFn: async () => {
      // A CLI login performed outside Gram may leave its discovery server holding old auth.
      if (profileId === undefined) await recheck();
      else await listing.refetch();
    },
  });
  const status =
    listing.isPending && value === "" ? (
      <span role="status" className="text-meta text-muted-foreground">
        Loading models…
      </span>
    ) : listing.isError ? (
      <div role="alert" className="flex items-center gap-2 text-meta text-destructive">
        <span>{errorMessage(listing.error)}</span>
        {retry.isError && <span>{errorMessage(retry.error)}</span>}
        <Button size="sm" variant="ghost" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? "Retrying…" : "Retry models"}
        </Button>
      </div>
    ) : undefined;
  return { options, refresh, status };
}

/**
 * The prompt box's Model section of its choices (`ComposerChoices`): the composer's searching list
 * with favourites, and with `onPick` every one of `agents`' models in it, picking another agent's
 * or gateway's switching to it. Another agent's models are asked for only once the popover opens.
 * While the models load, or failing with a retry, there is no section: `status` stands in its
 * place on the row, as the model picker's did.
 */
export function useModelSection({
  agent,
  profileId,
  value,
  onChange,
  agents,
  onPick,
}: {
  agent: AgentKind;
  profileId?: ProfileId | undefined;
  value: string;
  onChange: (model: string) => void;
  /** The agents whose models the list holds beside `agent`'s; only with `onPick`. */
  agents?: readonly AgentKind[] | undefined;
  /** Called for a model of another agent or gateway than `agent` and `profileId`. */
  onPick?: ((pick: ModelPick) => void) | undefined;
}): {
  section: ChoiceSection | undefined;
  status: ReactNode;
  onOpen: () => void;
  onClose: () => void;
} {
  const { options, refresh, status } = useModelListing(agent, profileId, value);
  const across = onPick !== undefined && agents !== undefined;
  const [opened, setOpened] = useState(false);
  const acrossOptions = useModelsAcross(
    across ? agents : [],
    { agent, profileId },
    options,
    opened,
  );
  const favourite = useIsFavourite(agent);
  const favouriteOf = useIsFavouriteOf();
  const onOpen = () => {
    refresh();
    setOpened(true);
  };
  // Closed, the other agents' lists are no longer asked for; what they fetched stays cached.
  const onClose = () => setOpened(false);
  if (status !== undefined) return { section: undefined, status, onOpen, onClose };
  if (!across)
    return {
      section: modelSection({
        value,
        options,
        onChange,
        search: {
          rowIcon: <AgentIcon agent={agent} className="size-icon-row" />,
          favourite,
          onToggleFavourite: (model) => useModelFavourites.getState().toggle(agent, model),
        },
      }),
      status,
      onOpen,
      onClose,
    };
  const shown = modelSection({ value, options, onChange });
  return {
    section: {
      ...modelSection({
        value: pickKey(agent, profileId, value),
        options: acrossOptions,
        onChange: (next) => {
          const pick = parsePick(next);
          if (pick.agent === agent && pick.profileId === profileId) onChange(pick.model);
          else onPick(pick);
        },
        search: {
          favourite: (next) => {
            const pick = parsePick(next);
            return favouriteOf(pick.agent, pick.model);
          },
          onToggleFavourite: (next) => {
            const pick = parsePick(next);
            useModelFavourites.getState().toggle(pick.agent, pick.model);
          },
        },
      }),
      // Named from the agent's own list, which has the model before the other agents' have loaded.
      named: shown.named,
      chip: shown.chip,
    },
    status,
    onOpen,
    onClose,
  };
}

/**
 * The model picker for Settings and other forms, fed by `models.list` (a gateway agent's models
 * come from `profileId`); it searches past `MODEL_SEARCH_THRESHOLD` models.
 */
export function ModelSelect({
  agent,
  profileId,
  value,
  onChange,
}: {
  agent: AgentKind;
  profileId?: ProfileId;
  value: string;
  onChange: (model: string) => void;
}) {
  const { options, refresh, status } = useModelListing(agent, profileId, value);
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    if (next) refresh();
    setOpenState(next);
  };
  const favourite = useIsFavourite(agent);
  if (status !== undefined) return status;
  if (options.length > MODEL_SEARCH_THRESHOLD) {
    return (
      <ModelCombobox
        label="Model"
        value={value}
        options={options}
        onChange={onChange}
        open={open}
        onOpenChange={setOpen}
        icon={undefined}
        rowIcon={<AgentIcon agent={agent} className="size-icon-row" />}
        title="Model"
        description={undefined}
        labelled
        favourite={favourite}
        onToggleFavourite={(model) => useModelFavourites.getState().toggle(agent, model)}
        field
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
      <SelectTrigger aria-label="Model">
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
