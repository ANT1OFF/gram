// Whether a thread's sessions get the user's browser, as the server opens them: the session
// policy's grant (`SessionPolicy.browser`, from the consents in Settings), then what the thread's
// own session can carry. The adapters hold the same lines (`chromeArgs`, Codex's `browserOff`), so
// what this says is what a session gets.
import { codexHomeFor } from "@gram/agents/codex";
import {
  type AgentKind,
  browserUseAllowed,
  type Connector,
  orchestratorBrowserOn,
  type Settings,
  type Thread,
  type ThreadBrowserStatus,
  workerBrowserOn,
} from "@gram/contracts";
import type { ResumeOptions } from "./history-plans.ts";
import type { SessionPolicy } from "./session-policy.ts";

/** Claude in Chrome's MCP server, and the ones Codex computer use runs through. */
const BROWSER_SERVERS: Record<AgentKind, ReadonlySet<string>> = {
  claude: new Set(["claude-in-chrome"]),
  codex: new Set(["cua_repl", "node_repl", "computer-use"]),
};

/**
 * What a running session that was opened with the browser still lacks to use it, read from its
 * own MCP servers, or `undefined` when one of the browser's servers is connected or still
 * starting. With none listed, only Codex is said to lack it: its computer use is a plugin's
 * server, there when the ChatGPT app installed it. Claude Code may not list its built-in one.
 */
export const browserNotReady = (
  agent: AgentKind,
  servers: ReadonlyArray<Pick<Connector, "name" | "status" | "error">>,
): string | undefined => {
  const own = servers.filter((server) => BROWSER_SERVERS[agent].has(server.name));
  if (own.some((server) => server.status === "connected" || server.status === "pending"))
    return undefined;
  const broken = own.find((server) => server.status !== "disabled") ?? own[0];
  if (broken === undefined)
    return agent === "codex"
      ? "This session has no computer-use server. Install computer use from the ChatGPT app, then restart the thread's session."
      : undefined;
  const detail = broken.error === undefined ? "" : ` (${broken.error})`;
  if (agent === "claude")
    return broken.status === "needs-auth"
      ? "Claude in Chrome needs you to sign in to claude.ai in the Claude extension."
      : `Claude in Chrome isn't connected${detail}. Check that Chrome is open with the Claude extension installed and signed in.`;
  return broken.status === "disabled"
    ? `Codex computer use is turned off in this session (${broken.name}). Restart the thread's session.`
    : `Codex computer use isn't running (${broken.name}: ${broken.status}${detail}). Check that the ChatGPT app is open.`;
};

/** What the thread's agent calls the browser it drives. */
const browserName = (thread: Pick<Thread, "model">) =>
  thread.model.agent === "claude" ? "Claude in Chrome" : "Codex computer use";

/**
 * Why this thread's session can't have the browser whatever is lent or allowed, or `undefined`.
 * A Codex thread has it only in the user's own `CODEX_HOME`, found as the adapter finds it
 * (`codexHomeFor`) from `resume`, the options its next open resumes or forks with
 * (`makeResumePlans`): the home it recorded, an anchored fork's source home, else the one a new
 * session picks. So one that started under an outward gate stays in Gram's own home after the
 * gate is lifted, and so does a cold fork of such a session.
 */
export const browserCannot = (
  thread: Pick<Thread, "role" | "profile" | "model">,
  resume: Pick<ResumeOptions, "codexHome" | "resumeId">,
  outwardGate: SessionPolicy["outwardGate"],
): string | undefined => {
  if (thread.role === "dream") return "A dream never has your browser.";
  if (thread.profile !== undefined)
    return "A thread started from a profile keeps to its profile's tools.";
  if (thread.model.agent === "claude") {
    return thread.model.profileId === undefined
      ? undefined
      : "Claude in Chrome needs a claude.ai sign-in, and this thread runs on a gateway.";
  }
  const home = codexHomeFor({
    ...(resume.codexHome === undefined ? {} : { codexHome: resume.codexHome }),
    ...(resume.resumeId === undefined ? {} : { resumeId: resume.resumeId }),
    model: thread.model,
    ...(outwardGate === undefined ? {} : { outwardGate }),
  });
  if (home === "user") return undefined;
  return home === "gateway"
    ? "Codex computer use runs only in your own Codex setup, and this thread runs on a gateway."
    : "Codex computer use runs only in your own Codex setup, and this thread's session runs in Gram's own, where it started under an outward gate.";
};

/**
 * The thread's browser as its next session gets it, given its policy as the server reads it now
 * and `resume`, the options that session opens with.
 */
export const browserStatus = (
  thread: Pick<Thread, "role" | "spawnedBy" | "browser" | "profile" | "model">,
  settings: Settings,
  policy: Pick<SessionPolicy, "browser" | "outwardGate">,
  resume: Pick<ResumeOptions, "codexHome" | "resumeId">,
): ThreadBrowserStatus => {
  const cannot = browserCannot(thread, resume, policy.outwardGate);
  const lent =
    thread.role === "orchestrator" ? orchestratorBrowserOn(settings) : thread.browser === true;
  if (!lent || thread.role === "dream")
    return cannot === undefined ? { state: "off" } : { state: "off", cannot };
  if (cannot !== undefined) return { state: "unavailable", why: cannot, cannot };
  if (policy.browser === true) return { state: "on" };
  return {
    state: "held",
    why: !browserUseAllowed(settings, thread.model.agent)
      ? `${browserName(thread)} is off in Settings → Agents.`
      : thread.role !== "orchestrator" &&
          thread.spawnedBy !== undefined &&
          !workerBrowserOn(settings)
        ? "Workers' browser is off in Settings → Workspaces."
        : "Its sessions don't get it.",
  };
};
