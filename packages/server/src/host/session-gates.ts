// What an older or narrower host can't open or read: the refusals of a session it doesn't run,
// and the orchestration digests rewritten for a host that doesn't know a worker's agent.

import {
  type AgentKind,
  type HostHello,
  type HostSessionOpen,
  hostServes,
  type UserInput,
} from "@gram/contracts";

/**
 * Why a session isn't opened on a host that doesn't name `browser-policy`: it would drop the
 * session's `browser` and run the CLI's own default, which may turn Claude in Chrome on.
 */
export const HOST_BROWSER_POLICY_MISSING =
  "Its gram-host is older than this Gram and can't keep Claude in Chrome off. Update Gram there (Settings → Machines), then try again.";

/** Why a memory update isn't opened on a host that doesn't name `dream-sessions`. */
export const HOST_DREAMS_MISSING =
  "Its gram-host is older than this Gram and doesn't run memory updates. Update Gram there (Settings → Machines), then try again.";

/** Why a Codex session isn't opened on a host that doesn't name `agent-codex`. */
export const HOST_CODEX_MISSING =
  "Its gram-host is older than this Gram and doesn't run Codex sessions. Update Gram there (Settings → Machines), then try again.";

/** Why an OpenCode session isn't opened on a host that doesn't name `agent-opencode-sessions`. */
export const HOST_OPENCODE_SESSIONS_MISSING =
  "Its gram-host is older than this Gram and doesn't run OpenCode sessions. Update Gram there (Settings → Machines), then try again.";

/** Why a Grok Build session isn't opened on a host that doesn't name `agent-grok`. */
export const HOST_GROK_MISSING =
  "Its gram-host doesn't run Grok Build sessions: it is older than this Gram, or has no Grok Build. Update Gram there (Settings → Machines), then try again.";

/** Why an OpenCode session isn't opened on a host that doesn't name `agent-opencode`. */
export const HOST_OPENCODE_MISSING =
  "Its gram-host is older than this Gram and doesn't know OpenCode. Update Gram there (Settings → Machines), then try again.";

/**
 * `input` as a host that doesn't know OpenCode can read it: an orchestration digest names each
 * worker's agent, and an OpenCode worker's is left out, as a ledger from before agents were named.
 */
export const withoutOpenCodeAgents = (input: UserInput): UserInput =>
  withoutAgents(input, "opencode");

/** `input` with `agent`'s workers named by no agent, for a host that doesn't know that kind. */
export const withoutAgents = (input: UserInput, agent: AgentKind): UserInput => {
  const notice = input.notice;
  if (notice?.kind !== "orchestration") return input;
  if (!notice.features.some((f) => f.workers.some((w) => w.agent === agent))) return input;
  return {
    ...input,
    notice: {
      ...notice,
      features: notice.features.map((feature) => ({
        ...feature,
        workers: feature.workers.map((worker) => {
          if (worker.agent !== agent) return worker;
          const { agent: _agent, ...rest } = worker;
          return rest;
        }),
      })),
    },
  };
};

/**
 * Why `request` isn't opened on the host that said `hello`, whoever routed it there: it can't hold
 * the browser off, or doesn't run the agent or a memory update. `undefined` when it can open it.
 */
export const openRefusal = (
  hello: Pick<HostHello, "capabilities" | "features">,
  request: HostSessionOpen,
): string | undefined => {
  if (!hostServes(hello, "browser-policy")) return HOST_BROWSER_POLICY_MISSING;
  if (request.agent === "opencode" && !hostServes(hello, "agent-opencode"))
    return HOST_OPENCODE_MISSING;
  if (request.agent === "codex" && !hostServes(hello, "agent-codex")) return HOST_CODEX_MISSING;
  if (request.agent === "opencode" && !hostServes(hello, "agent-opencode-sessions"))
    return HOST_OPENCODE_SESSIONS_MISSING;
  if (request.agent === "grok" && !hostServes(hello, "agent-grok")) return HOST_GROK_MISSING;
  // An older host would drop the field and open an ordinary session, with its native tools,
  // where the dream's prompt asks it to write.
  if (
    (request.dreamFilesOnly === true || request.audience === "dream") &&
    !hostServes(hello, "dream-sessions")
  )
    return HOST_DREAMS_MISSING;
  return undefined;
};

/** `input` as the host that said `hello` can read it, its unknown agents' workers left unnamed. */
export const readableBy =
  (hello: Pick<HostHello, "capabilities" | "features">) =>
  (input: UserInput): UserInput => {
    const known = hostServes(hello, "agent-opencode") ? input : withoutAgents(input, "opencode");
    return hostServes(hello, "agent-grok") ? known : withoutAgents(known, "grok");
  };
