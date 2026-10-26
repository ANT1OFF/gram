import type { CustomModel } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useModelsSettled } from "@/composer/models";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useServerSettings } from "@/settings-sync/store";

import {
  CUSTOM_MODEL_AGENTS,
  isCustomModelAgent,
  pendingSuggestions,
  validateCustomModels,
  type CustomModelDraft,
} from "./custom-models";
import { DraftRow } from "./draft-row";
import { Field, inputCls, Toggle, WhyDisabled } from "./fields";
import { SETTINGS_CARD } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";

const AGENT_ITEMS = CUSTOM_MODEL_AGENTS.map((agent) => ({
  value: agent,
  label: agentLabel(agent),
}));

let nextKey = 0;
const toDrafts = (models: ReadonlyArray<CustomModel>): CustomModelDraft[] =>
  models.flatMap((model) =>
    isCustomModelAgent(model.agent)
      ? [
          {
            key: `model-${nextKey++}`,
            agent: model.agent,
            id: model.id,
            name: model.name ?? "",
            effort: model.effort !== false,
          },
        ]
      : [],
  );

/** The drafts as saved models, for comparing with the stored list; `undefined` while invalid. */
const asSaved = (drafts: ReadonlyArray<CustomModelDraft>) => {
  const { models } = validateCustomModels(drafts);
  return models === undefined ? undefined : JSON.stringify(models);
};

/** Settings → Custom models: model ids the pickers offer beyond what each agent lists itself. */
export function CustomModelsSection() {
  const settings = useServerSettings((s) => s.settings);
  const [status, setStatus] = useState<string>();
  if (!settings) return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  const saved = settings.agents.customModels ?? [];
  return (
    <CustomModelsEditor
      // A save from elsewhere resets the drafts.
      key={JSON.stringify(saved)}
      saved={saved}
      status={status}
      onStatus={setStatus}
    />
  );
}

function CustomModelsEditor({
  saved,
  status,
  onStatus,
}: {
  saved: ReadonlyArray<CustomModel>;
  status: string | undefined;
  onStatus: (status: string | undefined) => void;
}) {
  const save = useSaveSettings();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState(() => toDrafts(saved));
  const [rows, setRows] = useState<ReadonlyArray<string | undefined>>([]);
  const [error, setError] = useState<string>();
  // Saved models start folded to a line each; one just added opens on its form.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const setOpenKey = (key: string, next: boolean) =>
    setOpen((was) => {
      const set = new Set(was);
      if (next) set.add(key);
      else set.delete(key);
      return set;
    });
  const addDraft = (draft: CustomModelDraft) => {
    onStatus(undefined);
    setDrafts((list) => [...list, draft]);
    setOpenKey(draft.key, true);
  };

  const dirty = asSaved(drafts) !== JSON.stringify(saved);

  // Ids the user's own Claude Code config mentions. An agent advertises no early-access model, so
  // where it was already used is the only place one can be found; a model the agent does list needs
  // no row here and is left out.
  const api = useApi();
  const suggested = useQuery({
    queryKey: ["model-suggestions"],
    queryFn: () => api.modelSuggestions(),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const claude = useModelsSettled("claude");
  const suggestions = pendingSuggestions(
    suggested.data?.suggestions ?? [],
    drafts,
    claude.settled ? { claude: claude.models?.map((model) => model.id) ?? "unavailable" } : {},
  );

  const update = (key: string, patch: Partial<CustomModelDraft>) => {
    onStatus(undefined);
    setDrafts((list) => list.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  };

  const submit = async () => {
    setError(undefined);
    const result = validateCustomModels(drafts);
    setRows(result.rows);
    if (result.models === undefined) return;
    try {
      await save({ agents: { customModels: result.models } });
      // Every model picker reads `models.list`, which it otherwise keeps for five minutes.
      await queryClient.invalidateQueries({ queryKey: ["models"] });
      onStatus("Custom models saved.");
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="custom-models">
      <ul className={cn(SETTINGS_CARD, "empty:hidden")}>
        {drafts.map((draft, i) => (
          <DraftRow
            key={draft.key}
            label={`Custom model ${i + 1}`}
            open={open.has(draft.key) || rows[i] !== undefined}
            onOpenChange={(next) => setOpenKey(draft.key, next)}
            onRemove={() => {
              onStatus(undefined);
              setRows([]);
              setDrafts((list) => list.filter((item) => item.key !== draft.key));
            }}
            error={rows[i]}
            summary={
              <>
                <AgentIcon agent={draft.agent} className="size-4" />
                <span className="truncate font-medium">
                  {draft.name.trim() || draft.id.trim() || "New model"}
                </span>
                {draft.name.trim() !== "" && draft.id.trim() !== "" && (
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {draft.id.trim()}
                  </span>
                )}
                {!draft.effort && (
                  <span className="shrink-0 text-xs text-muted-foreground">no effort</span>
                )}
              </>
            }
          >
            <Field label="Agent">
              <Select
                value={draft.agent}
                items={AGENT_ITEMS}
                onValueChange={(agent) => {
                  if (agent !== null) update(draft.key, { agent });
                }}
              >
                <SelectTrigger aria-label="Agent" className="self-start">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGENT_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Model id"
              description="Exactly what the agent takes as its model."
              htmlFor={`${draft.key}-id`}
            >
              <input
                id={`${draft.key}-id`}
                className={`${inputCls} font-mono`}
                value={draft.id}
                placeholder="opus[1m]"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => update(draft.key, { id: event.target.value })}
              />
            </Field>
            <Field
              label="Name"
              description="What the picker shows. Leave empty to show the id."
              htmlFor={`${draft.key}-name`}
            >
              <input
                id={`${draft.key}-name`}
                className={inputCls}
                value={draft.name}
                placeholder="Opus, 1M context"
                onChange={(event) => update(draft.key, { name: event.target.value })}
              />
            </Field>
            <Toggle
              label="Offer reasoning effort"
              description="Turn off for a model that rejects an effort setting."
              checked={draft.effort}
              onChange={(effort) => update(draft.key, { effort })}
            />
          </DraftRow>
        ))}
      </ul>
      {suggestions.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="model-suggestions">
          <p className="text-xs text-muted-foreground">
            Used in Claude Code on this machine, and not listed by the agent:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((suggestion) => (
              <Button
                key={`${suggestion.agent}:${suggestion.id}`}
                size="sm"
                variant="outline"
                title={`From ${suggestion.source}`}
                aria-label={`Add ${suggestion.id}`}
                className="font-mono"
                onClick={() =>
                  addDraft({
                    key: `model-${nextKey++}`,
                    agent: suggestion.agent,
                    id: suggestion.id,
                    name: "",
                    effort: true,
                  })
                }
              >
                + {suggestion.id}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            addDraft({ key: `model-${nextKey++}`, agent: "claude", id: "", name: "", effort: true })
          }
        >
          Add model
        </Button>
        <WhyDisabled reason={dirty ? undefined : "Nothing to save: no changes yet."}>
          <Button size="sm" disabled={!dirty} onClick={() => void submit()}>
            Save
          </Button>
        </WhyDisabled>
      </div>
      {status && (
        <p role="status" className="gram-fade text-muted-foreground">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
