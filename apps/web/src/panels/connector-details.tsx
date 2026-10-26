import type { ClaudeAiConnector, ConnectorTool } from "@gram/contracts";
import { Ban, Building2, ChevronRight, Eye, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "@/lib/utils";

const READ_ONLY_HINT = "Read-only: the server says it changes nothing";
const DESTRUCTIVE_HINT = "Destructive: the server says it may delete or overwrite";
const ORG_MANAGED_HINT = "Your organisation manages its sign-in";

/** A tool's hints as glyphs, each named on hover and to a screen reader. */
function ToolHints({ tool }: { tool: ConnectorTool }) {
  return (
    <>
      {tool.readOnly === true && (
        <Eye role="img" aria-label={READ_ONLY_HINT} className="size-3 shrink-0 text-success">
          <title>{READ_ONLY_HINT}</title>
        </Eye>
      )}
      {tool.destructive === true && (
        <TriangleAlert
          role="img"
          aria-label={DESTRUCTIVE_HINT}
          className="size-3 shrink-0 text-warning"
        >
          <title>{DESTRUCTIVE_HINT}</title>
        </TriangleAlert>
      )}
    </>
  );
}

/**
 * A connector's tools, folded to a count until asked for, each with the read-only or destructive
 * hint its server gives. Only what the server says: a tool without a hint shows none.
 */
export function ConnectorTools({
  name,
  tools,
  className,
}: {
  /** The connector's name, for the toggle's label. */
  name: string;
  tools: ReadonlyArray<ConnectorTool>;
  className?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (tools.length === 0) return null;
  const destructive = tools.filter((tool) => tool.destructive === true).length;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${tools.length} tools of ${name}`}
        onClick={() => setOpen(!open)}
        className="flex w-fit items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3 shrink-0 motion-safe:transition-transform", open && "rotate-90")}
        />
        <span className="tabular-nums">
          {tools.length} {tools.length === 1 ? "tool" : "tools"}
        </span>
        {destructive > 0 && (
          <span
            className="flex items-center gap-0.5 text-warning"
            title={`${destructive} the server calls destructive`}
          >
            <TriangleAlert aria-hidden className="size-3" />
            <span className="tabular-nums">{destructive}</span>
          </span>
        )}
      </button>
      <ul
        id={listId}
        hidden={!open}
        aria-label={`Tools of ${name}`}
        className="flex flex-wrap gap-1"
      >
        {tools.map((tool) => (
          <li
            key={tool.name}
            className="flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 font-mono"
          >
            <span className="truncate">{tool.name}</span>
            <ToolHints tool={tool} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What claude.ai says of a connector that the row's state doesn't: a policy block, a managed sign-in. */
export function ClaudeAiMarks({ claudeAi }: { claudeAi: ClaudeAiConnector | undefined }) {
  if (claudeAi === undefined) return null;
  return (
    <>
      {claudeAi.blocked !== undefined && (
        <Ban
          role="img"
          aria-label={`Blocked by policy: ${claudeAi.blocked}`}
          className="size-3.5 shrink-0 text-muted-foreground"
        >
          <title>{`Blocked by policy: ${claudeAi.blocked}`}</title>
        </Ban>
      )}
      {claudeAi.orgManaged === true && (
        <Building2
          role="img"
          aria-label={ORG_MANAGED_HINT}
          className="size-3.5 shrink-0 text-muted-foreground"
        >
          <title>{ORG_MANAGED_HINT}</title>
        </Building2>
      )}
    </>
  );
}
