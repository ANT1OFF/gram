import type { ThreadId } from "@gram/contracts";

import { useModelsSettled } from "@/composer/models";
import { useLaunchChecks } from "@/launch-checks/use-launch-checks";
import { useThreadsStore } from "@/stores/threads";

import { installed, otherAgent, switchOffer, type SwitchOffer } from "./agent-switch-model";

/**
 * Whether "Continue in Codex…" (or "…in Claude Code…") is offered on this thread, and why it's
 * greyed: from the thread's own state, the launch checks' install and sign-in and the other agent's
 * model list, never from credentials.
 */
export function useSwitchOffer(threadId: ThreadId): SwitchOffer {
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const { checks } = useLaunchChecks();
  // Partial summaries (a thread still loading) have no model yet: nothing is offered.
  const agent = summary?.thread.model?.agent;
  const to = summary?.thread.sessionSwitch?.target.agent ?? otherAgent(agent ?? "claude");
  const wanted = agent !== undefined;
  const { models } = useModelsSettled(to, wanted && installed(checks, to));
  if (summary === undefined || agent === undefined) return { offered: false };
  return switchOffer({
    summary,
    checks,
    platform: typeof window === "undefined" ? undefined : window.gram?.platform,
    listed: (models?.length ?? 0) > 0,
  });
}
