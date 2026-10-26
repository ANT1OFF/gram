import type { DesktopBridge, PendingRequest, RequestAnswer, ThreadId } from "@gram/contracts";

type AgentBrowse = NonNullable<DesktopBridge["agentBrowse"]>;

/** Raises a pending request on a thread and hears its answer: `MockCore.simulateRequest`. */
type Ask = (
  threadId: ThreadId,
  request: PendingRequest,
  onAnswer: (answer: RequestAnswer) => void,
) => void;

/**
 * The shell's "Agent may browse" list, for the mock API: `agentBrowseHosts` is what specs read, and
 * `simulateBrowseApproval` raises the card an agent's `browser_navigate` raises for a new host,
 * whose "Always for this host" adds it as the shell does once the server grants it.
 */
export function createAgentBrowseMock(ask: Ask) {
  const agentBrowseHosts: string[] = [];
  const listeners = new Set<(hosts: readonly string[]) => void>();
  const changed = () => {
    for (const listener of listeners) listener([...agentBrowseHosts]);
  };
  const agentBrowse: AgentBrowse = {
    list: async () => [...agentBrowseHosts],
    remove: async (host) => {
      const at = agentBrowseHosts.indexOf(host);
      if (at === -1) return;
      agentBrowseHosts.splice(at, 1);
      changed();
    },
    onChange: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  return {
    shell: { agentBrowse },
    agentBrowseHosts,
    /** Dev and e2e hook: the card for an agent asking to open `url` on `host`. */
    simulateBrowseApproval(threadId: ThreadId, host: string, id = `browse-${host}`) {
      ask(
        threadId,
        {
          kind: "approval",
          id: id as never,
          toolName: "mcp__gram__browser_navigate",
          displayName: "browser_navigate",
          input: { url: `https://${host}/` },
          description: `Let the agent open ${host} in the Preview pane? It can read the pages there and click, type and fill in forms; submitting a form asks every time. “Always” adds ${host} to Settings → Agent may browse.`,
          suggestions: [],
          scopes: ["once", "always"],
          browseHost: host,
        },
        (answer) => {
          if (answer.kind !== "approval" || answer.decision !== "allow") return;
          if (answer.scope === "always" && !agentBrowseHosts.includes(host)) {
            agentBrowseHosts.push(host);
            agentBrowseHosts.sort();
            changed();
          }
        },
      );
    },
  };
}
