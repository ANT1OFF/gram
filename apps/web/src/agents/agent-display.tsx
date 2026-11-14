import type { AgentKind } from "@gram/contracts";
import { Plug } from "lucide-react";
import type { ComponentType } from "react";

import { cn } from "@/lib/utils";

import { AGENT_LABEL, agentLabel } from "./agent-label";
import { type AgentMarkProps, ClaudeMark, OpenAiMark } from "./agent-marks";

export { agentLabel } from "./agent-label";

export interface AgentDisplay {
  readonly label: string;
  readonly icon: ComponentType<AgentMarkProps>;
  /** Its provider's brand colour (`provider-*`), which its mark wears wherever it is drawn. */
  readonly tone: string;
}

/** How each agent is named (`AGENT_LABEL`) and drawn: pane headers, sidebar rows, pickers, ⌘K and resume. */
export const AGENT_DISPLAY: Readonly<Record<AgentKind, AgentDisplay>> = {
  claude: { label: AGENT_LABEL.claude, icon: ClaudeMark, tone: "text-provider-anthropic" },
  codex: { label: AGENT_LABEL.codex, icon: OpenAiMark, tone: "text-provider-openai" },
};

const displayOf = (agent: string): AgentDisplay | undefined =>
  Object.hasOwn(AGENT_DISPLAY, agent) ? AGENT_DISPLAY[agent as AgentKind] : undefined;

/**
 * An agent's mark, in its provider's brand colour: Claude's orange, OpenAI's black or white. The
 * colour says whose it is, never a status, and a `text-*` class in `className` replaces it where a
 * mark has to step back. Decorative next to its name; `labelled` where it stands alone, so it is
 * the name to a screen reader. A kind this build doesn't know gets a plug in the text colour.
 */
export function AgentIcon({
  agent,
  className,
  labelled = false,
}: {
  agent: string;
  className?: string;
  labelled?: boolean;
}) {
  const display = displayOf(agent);
  const Icon = display?.icon ?? Plug;
  const naming = labelled
    ? { role: "img", "aria-label": agentLabel(agent) }
    : { "aria-hidden": true };
  return <Icon {...naming} className={cn("shrink-0", display?.tone, className)} />;
}
