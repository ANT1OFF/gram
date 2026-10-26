import type { OrchestratorCharter } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";

import { ConnectorEntries } from "./connector-entries";
import { Field, OptionGroup } from "./fields";
import {
  CONNECTOR_MODES,
  connectorChoice,
  connectorSuggestions,
  withConnectors,
  type ConnectorMode,
} from "./workspace-settings-model";

/**
 * The charter's connector set: which connectors and MCP servers the workspace's orchestrator and
 * workers get. The picker offers what Settings → Connectors reads, which connects nothing, and only
 * once there is a list to fill.
 */
export function WorkspaceConnectorsField({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  /** Saves the charter; settles once the server has it, and rejects with its refusal. */
  onChange: (next: OrchestratorCharter) => Promise<unknown>;
}) {
  const api = useApi();
  const id = useId();
  const saved = connectorChoice(charter);
  const { entries } = saved;
  // A list picked with nothing on it yet narrows nothing until its first entry is added, so
  // choosing "Only these" doesn't take every connector away from running threads on the spot.
  const [pending, setPending] = useState<ConnectorMode>();
  const mode = pending ?? saved.mode;
  const [error, setError] = useState<string>();
  const { data } = useQuery({
    queryKey: ["connector-suggestions"],
    queryFn: () => api.listConfiguredConnectors({}),
    enabled: mode !== "all",
    retry: false,
  });
  const suggestions = connectorSuggestions(data?.agents ?? []);

  const pick = (next: ConnectorMode) => {
    setError(undefined);
    if (next !== "all" && entries.length === 0) {
      setPending(next);
      return;
    }
    setPending(undefined);
    onChange(withConnectors(charter, next, entries)).catch((e: unknown) =>
      setError(errorMessage(e)),
    );
  };

  return (
    <Field
      label="Connectors"
      description="The connectors and MCP servers this workspace's threads get beside Gram's own."
      learnMore={
        <p>
          List a server by its name (parse), or a claude.ai connector by its address
          (https://mcp.example.invalid/teams; * matches anything). Claude Code and Codex threads are
          all held to it; a running thread picks a change up once it is idle.
        </p>
      }
      keywords={["mcp", "connectors", "allowlist", "denylist", "claude.ai", "tools", "servers"]}
      {...(mode === "all" ? {} : { htmlFor: id })}
    >
      <div className="flex flex-col gap-2" data-testid="workspace-connectors" data-mode={mode}>
        <OptionGroup
          label="Connectors"
          options={CONNECTOR_MODES}
          value={mode}
          disabled={disabled}
          onChange={pick}
        />
        {mode !== "all" && (
          <ConnectorEntries
            id={id}
            entries={entries}
            suggestions={suggestions}
            disabled={disabled}
            onChange={(next) =>
              onChange(withConnectors(charter, mode, next)).then(() => setPending(undefined))
            }
          />
        )}
        {saved.mode === "allow" && entries.length === 0 && pending === undefined && (
          <p className="text-xs text-muted-foreground">
            With nothing listed, its threads get only Gram's own tools.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </Field>
  );
}
