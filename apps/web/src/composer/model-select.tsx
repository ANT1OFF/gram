import { AgentKind, ProfileId } from "@gram/contracts";
import { useMutation, useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import type { ShellAgent, ShellModelsNone } from "@/embed/contract";
import { useEmbedShell } from "@/embed/store";
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
  allowedModels,
  CUSTOM_GROUP,
  MODEL_SEARCH_THRESHOLD,
  modelOptions,
  offeredModels,
  offeredReplacement,
  pickerModelId,
  servedRows,
  unlistedWarning,
  useModelsAllowed,
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

const pickKey = (agent: AgentKind, profileId: ProfileId | undefined, model: string) =>
  JSON.stringify([agent, profileId ?? null, model]);

const decodePickKey = Schema.decodeSync(
  Schema.fromJsonString(Schema.Tuple([AgentKind, Schema.NullOr(ProfileId), Schema.String])),
);

const parsePick = (key: string): ModelPick => {
  const [agent, profileId, model] = decodePickKey(key);
  return profileId === null ? { agent, model } : { agent, profileId, model };
};

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

function useModelsAcross(
  agents: readonly AgentKind[],
  current: { agent: AgentKind; profileId?: ProfileId | undefined },
  currentOptions: readonly PickerOption<string>[],
  open: boolean,
): PickerOption<string>[] {
  const api = useApi();
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
  const { offered, listed: served, paidBy } = useEmbedShell((s) => s.models);
  const limit = useModelsAllowed();
  const own: PickerOption<string>[] = [];
  const custom: PickerOption<string>[] = [];
  agents.forEach((agent, index) => {
    const onAccount = agent === current.agent && current.profileId === undefined;
    const listed = onAccount
      ? currentOptions
      : modelOptions(
          offeredModels(
            allowedModels(
              listings[index]?.data?.models ??
                (listings[index]?.isError === true ? servedRows(served?.[agent]) : undefined),
              agent,
              limit,
            ),
            agent,
            offered,
            undefined,
            paidBy,
          ),
          undefined,
          [],
          undefined,
          agentLabel(agent),
        );
    for (const row of keyed(agent, undefined, listed))
      (row.group === CUSTOM_GROUP ? custom : own).push(row);
  });
  const gateway =
    current.profileId === undefined || !agents.includes(current.agent)
      ? []
      : keyed(current.agent, current.profileId, currentOptions);
  return [...own, ...custom, ...gateway];
}

const noneOf = (
  none: ShellModelsNone | ((agent: ShellAgent) => ShellModelsNone | undefined) | undefined,
  agent: AgentKind,
): ShellModelsNone | undefined => {
  try {
    return typeof none === "function" ? none(agent) : none;
  } catch {
    return undefined;
  }
};

function NoModels({ none }: { none: ShellModelsNone }) {
  return (
    <>
      <span className="min-w-0 whitespace-normal">{none.text}</span>
      {none.action !== undefined && (
        <Link
          to={none.action.to}
          className="rounded-sm text-meta text-foreground underline underline-offset-2 outline-none hover:text-foreground/80 focus-visible:focus-ring"
        >
          {none.action.label}
        </Link>
      )}
    </>
  );
}

function useModelListing(
  agent: AgentKind,
  profileId: ProfileId | undefined,
  value: string,
  keep: boolean,
) {
  const listing = useModelsQuery(agent, profileId);
  const provider = useProviderLabel(agent, profileId);
  const { offered, none: noneFor, paidBy } = useEmbedShell((s) => s.models);
  const none = noneOf(noneFor, agent);
  const listed = offeredModels(listing.data?.models, agent, offered, profileId, paidBy);
  const replacement = offeredReplacement(listed, offered !== undefined, value);
  const notOffered =
    offered !== undefined &&
    listed !== undefined &&
    value !== "" &&
    !listed.some((model) => model.id === value || model.resolvedId === value);
  const shown = pickerModelId(listed, value) ?? value;
  const options = modelOptions(
    listed,
    !keep && notOffered ? undefined : shown,
    agent === "claude" && profileId === undefined ? undefined : [],
    unlistedWarning(agent, profileId),
    provider,
  );
  const refresh = useRefreshModels(agent, profileId);
  const { recheck } = useLaunchChecks();
  const retry = useMutation({
    mutationFn: async () => {
      if (profileId === undefined) await recheck();
      else await listing.refetch();
    },
  });
  const empty = none !== undefined && listed !== undefined && listed.length === 0;
  const status =
    listing.isPending && value === "" ? (
      <span role="status" className="text-meta text-muted-foreground">
        Loading models…
      </span>
    ) : listing.isError ? (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-meta text-destructive">
        <span>{errorMessage(listing.error)}</span>
        {retry.isError && <span>{errorMessage(retry.error)}</span>}
        <Button size="sm" variant="ghost" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? "Retrying…" : "Retry models"}
        </Button>
        {none !== undefined && <NoModels none={none} />}
      </div>
    ) : empty ? (
      <div
        role="status"
        className="flex min-w-0 flex-wrap items-center gap-2 text-meta text-muted-foreground"
      >
        <NoModels none={none} />
      </div>
    ) : undefined;
  return { options, refresh, status, empty, replacement, shown };
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
  keep = false,
}: {
  agent: AgentKind;
  profileId?: ProfileId | undefined;
  value: string;
  onChange: (model: string) => void;
  /** A saved setting, shown as it is: a draft moves off a model the embedding app does not offer. */
  keep?: boolean | undefined;
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
  const {
    options,
    refresh,
    status,
    empty,
    replacement,
    shown: picked,
  } = useModelListing(agent, profileId, value, keep);
  const moveTo = useEffectEvent((model: string) => onChange(model));
  useEffect(() => {
    if (!keep && replacement !== undefined) moveTo(replacement);
  }, [keep, replacement]);
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
  const onClose = () => setOpened(false);
  if (status !== undefined && !(empty && across))
    return { section: undefined, status, onOpen, onClose };
  if (!across)
    return {
      section: modelSection({
        value: picked,
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
  const shown = modelSection({ value: picked, options, onChange });
  return {
    section: {
      ...modelSection({
        value: pickKey(agent, profileId, picked),
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
      named: shown.named,
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
  const { options, refresh, status, shown } = useModelListing(agent, profileId, value, true);
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    if (next) refresh();
    setOpenState(next);
  };
  const favourite = useIsFavourite(agent);
  if (status !== undefined) return status;
  if (options.length > MODEL_SEARCH_THRESHOLD || options.some((option) => option.legacy)) {
    return (
      <ModelCombobox
        label="Model"
        value={shown}
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
      value={shown}
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
