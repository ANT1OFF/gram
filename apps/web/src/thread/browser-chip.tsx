import { autonomyOf, type Thread, type ThreadBrowserStatus, type ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Globe, GlobeLock, GlobeOff, TriangleAlert, type LucideIcon } from "lucide-react";

import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";

/** What the thread's agent calls the browser it drives. */
const browserName = (thread: Pick<Thread, "model">) =>
  thread.model.agent === "claude" ? "Claude in Chrome" : "Codex computer use";

/**
 * Whether the thread's next session gets your browser, as the server opens it
 * (`thread.browserStatus`). Asked again whenever something it reads changes here: the thread's
 * grant, agent, model and Codex home, the consents in Settings, and its workspace's autonomy (its
 * outward gate). `undefined` until the server answers, and for a thread that isn't loaded.
 */
export function useThreadBrowser(threadId: ThreadId | undefined): ThreadBrowserStatus | undefined {
  const api = useApi();
  const thread = useThreadsStore((s) =>
    threadId === undefined ? undefined : s.byId[threadId]?.thread,
  );
  const settings = useServerSettings((s) => s.settings);
  const workspaces = useWorkspaces();
  const charter = workspaces.find((w) => w.workspace.id === thread?.workspaceId)?.charter;
  const { data } = useQuery({
    queryKey: [
      "threadBrowser",
      threadId,
      thread?.browser === true,
      thread?.role,
      thread?.model,
      thread?.codexHome,
      thread?.agentSessionId,
      thread?.workspaceId,
      thread?.spawnedBy?.threadId,
      charter === undefined ? undefined : autonomyOf(charter),
      settings?.agents.claudeInChrome === true,
      settings?.agents.codexComputerUse === true,
      settings?.workspaces?.orchestratorBrowser === true,
      settings?.workspaces?.workerBrowser === true,
    ],
    queryFn: () => api.threadBrowserStatus(threadId!),
    enabled: threadId !== undefined && thread !== undefined,
    staleTime: 0,
    // Whether a lent browser is ready is the running session's to say, and changes without
    // anything here changing: the extension connects, the session reopens.
    refetchInterval: (query) => (query.state.data?.state === "on" ? 30_000 : false),
  });
  return data;
}

/** The chip's words and mark for `status`, or `undefined` when there is nothing to show. */
export const browserChipText = (
  thread: Pick<Thread, "model">,
  status: ThreadBrowserStatus | undefined,
): { readonly label: string; readonly hint: string; readonly Icon: LucideIcon } | undefined => {
  if (status === undefined || status.state === "off") return undefined;
  const name = browserName(thread);
  switch (status.state) {
    case "on":
      if (status.notReady !== undefined)
        return {
          label: "Your browser isn't ready",
          hint: `This thread has your browser, but can't reach it yet. ${status.notReady}`,
          Icon: TriangleAlert,
        };
      return {
        label: "Your browser",
        hint: `This thread can use your browser through ${name}, signed in as you. A change applies from its next session.`,
        Icon: Globe,
      };
    case "held":
      return {
        label: "Browser held back",
        hint: `You lent this thread your browser, but it doesn't get it. ${status.why ?? "A setting holds it back."}`,
        Icon: GlobeLock,
      };
    case "unavailable":
      return {
        label: "Browser not available",
        hint: status.why ?? `${name} isn't available to this thread.`,
        Icon: GlobeOff,
      };
  }
};

/**
 * "Your browser" in the pane header while the thread's sessions get your real browser, signed in
 * as you; "Your browser isn't ready" in the warning tone while its session can't reach it;
 * "Browser held back" while a consent in Settings holds it back, and "Browser not available"
 * where its session can't have it at all (a Codex thread in Gram's own Codex home, say). The hint
 * says why in each case.
 */
export function BrowserChip({ threadId, className }: { threadId: ThreadId; className?: string }) {
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const status = useThreadBrowser(threadId);
  if (thread === undefined) return null;
  const text = browserChipText(thread, status);
  if (text === undefined || status === undefined) return null;
  const { Icon } = text;
  return (
    <Hint
      label={text.hint}
      side="bottom"
      render={
        <span
          data-testid="pane-browser"
          data-state={status.state}
          data-ready={status.state === "on" && status.notReady === undefined}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 text-meta text-muted-foreground",
            status.state === "on" && status.notReady !== undefined && "text-warning",
            className,
          )}
        />
      }
    >
      <Icon aria-hidden className="size-icon-row" />
      {text.label}
    </Hint>
  );
}
