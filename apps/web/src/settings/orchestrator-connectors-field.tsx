import { useId } from "react";

import { ConnectorEntries } from "./connector-entries";
import { Field } from "./fields";

/**
 * The only MCP servers a Claude orchestrator keeps beside Gram's own, edited in place: each
 * change saves at once. Empty leaves it the default, and a workspace's own connectors narrow it.
 */
export function OrchestratorConnectorsField({
  entries,
  onChange,
}: {
  entries: readonly string[];
  /** Saves the whole list; settles once the server has it. */
  onChange: (entries: string[]) => Promise<unknown>;
}) {
  const id = useId();
  return (
    <Field
      label="Orchestrator connectors"
      description="Limit the connectors orchestrators get. Empty means all."
      learnMore={
        <>
          <p>
            List a server&apos;s name as Claude Code has it (parse), or a claude.ai connector&apos;s
            address (https://mcp.example.invalid/teams; * matches anything). A workspace&apos;s own
            connectors narrow this further, and a change applies from an orchestrator&apos;s next
            session.
          </p>
          <p>
            Empty gives a Claude orchestrator your connectors through tool search, except on a
            gateway key, which gets none. Codex orchestrators keep their own connectors, as far as
            their workspace allows.
          </p>
        </>
      }
      keywords={[
        "mcp",
        "connectors",
        "allowlist",
        "claude.ai",
        "tools",
        "orchestrator",
        "tool search",
        "gateway",
      ]}
      htmlFor={id}
    >
      <ConnectorEntries
        id={id}
        entries={entries}
        onChange={onChange}
        testId="orchestrator-connectors"
      />
    </Field>
  );
}
