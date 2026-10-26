import type { AgentKind } from "@gram/contracts";
import { Orbit, Plug } from "lucide-react";
import type { ComponentType } from "react";

import { cn } from "@/lib/utils";

import { AGENT_LABEL, agentLabel } from "./agent-label";
import { type AgentMarkProps, ClaudeMark, OpenAiMark } from "./agent-marks";

export { agentLabel } from "./agent-label";

export interface AgentDisplay {
  readonly label: string;
  readonly icon: ComponentType<AgentMarkProps>;
}

/** How each agent is named (`AGENT_LABEL`) and drawn: pane headers, sidebar rows, pickers, ⌘K and resume. */
export const AGENT_DISPLAY: Readonly<Record<AgentKind, AgentDisplay>> = {
  claude: { label: AGENT_LABEL.claude, icon: ClaudeMark },
  codex: { label: AGENT_LABEL.codex, icon: OpenAiMark },
  grok: { label: AGENT_LABEL.grok, icon: Orbit },
};

const displayOf = (agent: string): AgentDisplay | undefined =>
  Object.hasOwn(AGENT_DISPLAY, agent) ? AGENT_DISPLAY[agent as AgentKind] : undefined;

/**
 * An agent's mark. Decorative next to its name; `labelled` where it stands alone, so it is the
 * name to a screen reader. A kind this build doesn't know gets a plug.
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
  const Icon = displayOf(agent)?.icon ?? Plug;
  const naming = labelled
    ? { role: "img", "aria-label": agentLabel(agent) }
    : { "aria-hidden": true };
  return <Icon {...naming} className={cn("shrink-0", className)} />;
}
