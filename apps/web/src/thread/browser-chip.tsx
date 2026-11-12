import {
  browserUseAllowed,
  orchestratorBrowserOn,
  workerBrowserOn,
  type Settings,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import { Globe } from "lucide-react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";

/** What the thread's agent calls the browser it drives. */
const browserName = (thread: Pick<Thread, "model">) =>
  thread.model.agent === "claude" ? "Claude in Chrome" : "Codex computer use";

/**
 * Whether the thread has the user's browser, as the server's session policy decides it
 * (`browserFor`): `on`, `held` when it was given it but a consent in Settings is off, or
 * `undefined` when it wasn't given it. Codex's outward gate is the server's to know, not this.
 */
export const browserState = (
  thread: Pick<Thread, "role" | "spawnedBy" | "browser" | "model">,
  settings: Settings,
): { readonly state: "on" | "held"; readonly why?: string } | undefined => {
  if (thread.role === "dream") return undefined;
  const orchestrator = thread.role === "orchestrator";
  if (orchestrator ? !orchestratorBrowserOn(settings) : thread.browser !== true) return undefined;
  if (!browserUseAllowed(settings, thread.model.agent)) {
    return { state: "held", why: `${browserName(thread)} is off in Settings → Agents.` };
  }
  if (!orchestrator && thread.spawnedBy !== undefined && !workerBrowserOn(settings)) {
    return {
      state: "held",
      why: "Workers' browser is off in Settings → Workspaces.",
    };
  }
  return { state: "on" };
};

/**
 * "Your browser" in the pane header while the thread drives the user's real browser, signed in as
 * them; struck through while a consent in Settings holds it back.
 */
export function BrowserChip({ threadId, className }: { threadId: ThreadId; className?: string }) {
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const settings = useServerSettings((s) => s.settings);
  if (thread === undefined || settings === undefined) return null;
  const found = browserState(thread, settings);
  if (found === undefined) return null;
  const label =
    found.state === "on"
      ? `It can use your browser through ${browserName(thread)}, signed in as you. A change applies from its next session.`
      : `Given your browser, but it doesn't get it: ${found.why}`;
  return (
    <Hint
      label={label}
      side="bottom"
      render={
        <span
          data-testid="pane-browser"
          data-state={found.state}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 text-meta text-muted-foreground",
            found.state === "held" && "line-through",
            className,
          )}
        />
      }
    >
      <Globe aria-hidden className="size-icon-row" />
      Your browser
    </Hint>
  );
}
