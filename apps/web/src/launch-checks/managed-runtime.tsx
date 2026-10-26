import { codexRuntimeOf, type AgentRuntime } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { ExpandableError, Toggle } from "@/settings/fields";
import { useServerSettings } from "@/settings-sync/store";

import { installing } from "./agent-runtime-model";
import { AGENT_RUNTIMES_KEY, useRuntimeInstall } from "./use-agent-runtimes";

/**
 * The end of an agent's details on Settings → Agents, where Gram's store serves it: whether
 * new sessions use the managed runtime, Cancel while an install hasn't switched yet, why the last
 * one failed, and Roll back. The row carries Update and the progress.
 */
export function ManagedRuntimeControls({ runtime }: { runtime: AgentRuntime }) {
  const api = useApi();
  const client = useQueryClient();
  const agent = runtime.agent;
  const name = agentLabel(agent);
  const { state } = useRuntimeInstall(agent, true);
  // The persisted choice, not what resolved: after a lost store the row shows PATH or nothing, yet
  // sessions still refuse to start until the user turns this off.
  const settings = useServerSettings((s) => s.settings);
  const managedOn =
    settings === undefined
      ? runtime.resolved?.source === "managed"
      : codexRuntimeOf(settings) === "managed";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const act = async (what: string, run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await run();
      await client.invalidateQueries({ queryKey: AGENT_RUNTIMES_KEY });
    } catch (e) {
      setError(`Couldn't ${what}: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const active = state?.active;
  const previous = state?.previous;
  const cancellable = installing(state) || state?.state === "ready";
  const failure =
    state?.state === "failed" || state?.state === "rolledBack" ? state.message : undefined;

  return (
    <div
      className="flex flex-col gap-1.5 border-t border-border/60 pt-2"
      data-testid="managed-runtime"
      data-state={state?.state}
    >
      <Toggle
        label={`Use Gram-managed ${name}`}
        description={
          active === undefined
            ? `A verified ${name} for when yours is missing or incompatible. Your own stays the default.`
            : `A verified ${name} (${active.version}) for when yours is missing or incompatible. Same login, config and skills.`
        }
        checked={managedOn}
        disabled={busy || (active === undefined && !managedOn)}
        disabledReason="Install it first, with Update."
        onChange={(next) =>
          void act(next ? "switch to it" : "switch back", async () => {
            await api.setRuntimeSource(agent, next ? "managed" : "path");
            // The server keeps the choice in Settings; this window's copy follows.
            useServerSettings.setState({ settings: await api.getSettings() });
          })
        }
      />
      {cancellable && state !== undefined && "version" in state && (
        <div className="flex min-h-7 items-center gap-2">
          <span className="min-w-0 truncate text-muted-foreground">
            {state.state === "ready"
              ? `${state.version} switches over once no session is mid-turn.`
              : `Installing ${state.version}; ${active === undefined ? "nothing" : active.version} stays in use until it's verified.`}
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="ms-auto"
            disabled={busy}
            onClick={() => void act("cancel", () => api.cancelRuntimeInstall(agent))}
          >
            Cancel
          </Button>
        </div>
      )}
      {failure !== undefined && <ExpandableError message={failure} />}
      {previous !== undefined && !cancellable && (
        <div className="flex min-h-7 items-center gap-2">
          <span className="min-w-0 truncate text-muted-foreground">
            {`Keeps ${previous.version} in case this one misbehaves.`}
          </span>
          <Button
            size="xs"
            variant="outline"
            className="ms-auto"
            disabled={busy}
            data-testid="runtime-rollback"
            onClick={() => void act("roll back", () => api.rollbackRuntime(agent))}
          >
            {`Roll back to ${previous.version}`}
          </Button>
        </div>
      )}
      {error !== undefined && <ExpandableError message={error} />}
    </div>
  );
}
