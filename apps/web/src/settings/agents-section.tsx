import { restartOnMcpChangeOn, type PermissionMode, type SettingsPatch } from "@gram/contracts";
import { useState } from "react";

import { errorMessage } from "@/api/errors";
import { AgentFields, choiceModel } from "@/composer/agent-fields";
import { choiceFromModel } from "@/composer/default-choice";
import { useLocalDefaultChoice } from "@/composer/use-default-choice";
import { MODE_OPTIONS } from "@/composer/options";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useServerSettings } from "@/settings-sync/store";

import { AGENTS_DEFAULTS, resetFor } from "./defaults";
import { inputCls, SettingRow, Toggle } from "./fields";
import { SettingsGroup } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";

const IDLE_MINUTES = { min: 1, max: 1440 } as const;

type AgentsKey = keyof typeof AGENTS_DEFAULTS;

/**
 * Settings → Agents: what a new thread starts on, when idle sessions close, and whether they
 * restart after an MCP change.
 */
export function AgentsSection() {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const local = useLocalDefaultChoice(settings?.agents.defaultModel === undefined);
  const [failed, setFailed] = useState<{ key: AgentsKey; message: string }>();

  if (!settings) return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  const agents = settings.agents;

  const applyTo = (key: AgentsKey) => (patch: SettingsPatch) => {
    setFailed(undefined);
    save(patch).catch((e: unknown) => setFailed({ key, message: errorMessage(e) }));
  };
  const errorOf = (key: AgentsKey) => (failed?.key === key ? failed.message : undefined);
  const resetOf = (key: AgentsKey) => resetFor(settings, applyTo(key))(AGENTS_DEFAULTS[key]);

  return (
    <SettingsGroup label="New threads" testId="agent-settings">
      <SettingRow
        label="Default agent and model"
        description="What a new thread starts on. You can still pick another in /new."
        onReset={resetOf("defaultModel")}
        error={errorOf("defaultModel")}
      >
        {agents.defaultModel === undefined && local.discovering ? (
          <p role="status" className="text-sm text-muted-foreground">
            Discovering local agents…
          </p>
        ) : (
          <AgentFields
            value={
              agents.defaultModel === undefined
                ? local.choice
                : choiceFromModel(agents.defaultModel)
            }
            initializeDefault={agents.defaultModel !== undefined}
            onChange={(choice) =>
              applyTo("defaultModel")({ agents: { defaultModel: choiceModel(choice) } })
            }
          />
        )}
      </SettingRow>
      <SettingRow
        label="Default mode"
        description="How much a new thread asks before it acts."
        onReset={resetOf("defaultMode")}
        error={errorOf("defaultMode")}
      >
        <Select
          value={agents.defaultMode}
          items={MODE_OPTIONS}
          onValueChange={(value) => {
            if (value !== null && value !== agents.defaultMode) {
              applyTo("defaultMode")({ agents: { defaultMode: value as PermissionMode } });
            }
          }}
        >
          <SelectTrigger aria-label="Default mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {MODE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <IdleMinutesField
        // A value saved elsewhere resets the draft.
        key={agents.idleEvictMinutes}
        value={agents.idleEvictMinutes}
        onSave={(idleEvictMinutes) => applyTo("idleEvictMinutes")({ agents: { idleEvictMinutes } })}
        onReset={resetOf("idleEvictMinutes")}
        saveError={errorOf("idleEvictMinutes")}
      />
      <Toggle
        label="Restart on MCP change"
        description="Reload live sessions when Gram adds, removes or signs in to an MCP server."
        learnMore={
          <p>
            A Claude thread reconnects an added server at once. Otherwise the session restarts once
            idle, on the same conversation.
          </p>
        }
        keywords={["connectors", "reload", "restart session"]}
        checked={restartOnMcpChangeOn(settings)}
        onReset={resetOf("restartOnMcpChange")}
        error={errorOf("restartOnMcpChange")}
        onChange={(restartOnMcpChange) =>
          applyTo("restartOnMcpChange")({ agents: { restartOnMcpChange } })
        }
      />
    </SettingsGroup>
  );
}

function IdleMinutesField({
  value,
  onSave,
  onReset,
  saveError,
}: {
  value: number;
  onSave: (minutes: number) => void;
  onReset: (() => void) | undefined;
  saveError: string | undefined;
}) {
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState<string>();
  const commit = () => {
    const minutes = Number.parseInt(draft, 10);
    if (!Number.isInteger(minutes) || minutes < IDLE_MINUTES.min || minutes > IDLE_MINUTES.max) {
      setInvalid(
        `The idle timeout must be a whole number of minutes from ${IDLE_MINUTES.min} to ${IDLE_MINUTES.max}.`,
      );
      return;
    }
    setInvalid(undefined);
    if (minutes !== value) onSave(minutes);
  };
  return (
    <SettingRow
      label="Close idle sessions after"
      description="Close idle agent sessions to free memory. Sending restarts them; pinned threads stay open."
      htmlFor="settings-idle-minutes"
      onReset={onReset}
      error={invalid ?? saveError}
    >
      <span className="flex items-center gap-1.5">
        <input
          id="settings-idle-minutes"
          className={cn(inputCls, "w-20 tabular-nums")}
          value={draft}
          inputMode="numeric"
          aria-invalid={invalid !== undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
        <span aria-hidden className="text-muted-foreground">
          min
        </span>
      </span>
    </SettingRow>
  );
}
