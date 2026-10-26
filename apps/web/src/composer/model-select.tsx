import type { AgentKind, ProfileId } from "@gram/contracts";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { AgentIcon } from "@/agents/agent-display";
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

import { useIsFavourite, useModelFavourites } from "./model-favourites";
import { ModelCombobox } from "./model-picker";
import {
  MODEL_SEARCH_THRESHOLD,
  modelOptions,
  unlistedWarning,
  useModelsQuery,
  useRefreshModels,
} from "./models";
import { GHOST_TRIGGER } from "./styles";

/**
 * The model picker for drafts and Settings, fed by `models.list` (a gateway agent's models come
 * from `profileId`); past `MODEL_SEARCH_THRESHOLD` models it searches, with the composer's
 * favourites.
 */
export function ModelSelect({
  agent,
  profileId,
  value,
  onChange,
  ghost = false,
}: {
  agent: AgentKind;
  profileId?: ProfileId;
  value: string;
  onChange: (model: string) => void;
  /** Styled as a composer toolbar control, for the `/new` hero's prompt box. */
  ghost?: boolean;
}) {
  const listing = useModelsQuery(agent, profileId);
  // CLI aliases are a fallback only for local Claude, never for a gateway or another account.
  const options = modelOptions(
    listing.data?.models,
    value,
    agent === "claude" && profileId === undefined ? undefined : [],
    unlistedWarning(agent, profileId),
  );
  const refresh = useRefreshModels(agent, profileId);
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    if (next) refresh();
    setOpenState(next);
  };
  const favourite = useIsFavourite(agent);
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
