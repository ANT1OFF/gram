import { InvalidState, type AgentSessionSummary } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { resolveFolder } from "../../fs/folders.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { AgentHosts } from "../../runtime/agent-hosts.ts";
import type { Handlers } from "./common.ts";

/**
 * `sessions.list`: an agent's past sessions for a folder, marking the ones a thread already shows.
 * `sessions.delete`: removes one of them, unless a thread shows it.
 * `sessions.preview`: one session's first prompt and last reply, for the resume picker.
 */
export const sessionHandlers = Effect.gen(function* () {
  const hosts = yield* AgentHosts;
  const store = yield* ThreadStore;

  const openThreads = store.listThreads.pipe(
    Effect.map(
      (threads) =>
        new Map(
          threads.flatMap((t) =>
            t.agentSessionId === undefined ? [] : [[t.agentSessionId, t] as const],
          ),
        ),
    ),
  );

  return {
    "sessions.list": ({ agent, projectRoot, limit }) =>
      Effect.gen(function* () {
        const cwd = yield* resolveFolder(projectRoot);
        const host = yield* hosts.get(agent);
        if (!host.capabilities.listSessions || host.listSessions === undefined) {
          return { supported: false, sessions: [] };
        }
        const listed = yield* host.listSessions(limit === undefined ? { cwd } : { cwd, limit });
        const open = yield* openThreads;
        const sessions = listed.map((session): AgentSessionSummary => {
          const thread = open.get(session.agentSessionId);
          return thread === undefined ? session : { ...session, threadId: thread.id };
        });
        return { supported: true, sessions };
      }),

    "sessions.delete": ({ agent, projectRoot, agentSessionId }) =>
      Effect.gen(function* () {
        const cwd = yield* resolveFolder(projectRoot);
        const host = yield* hosts.get(agent);
        if (host.deleteSession === undefined) {
          return yield* new InvalidState({ message: "This agent can't delete past sessions." });
        }
        const thread = (yield* openThreads).get(agentSessionId);
        if (thread !== undefined) {
          return yield* new InvalidState({
            message: `“${thread.title}” shows this session. Close the thread to delete it.`,
            threadId: thread.id,
          });
        }
        yield* host.deleteSession({ cwd, agentSessionId });
      }),

    "sessions.preview": ({ agent, projectRoot, agentSessionId }) =>
      Effect.gen(function* () {
        const cwd = yield* resolveFolder(projectRoot);
        const host = yield* hosts.get(agent);
        if (host.previewSession === undefined) return {};
        return yield* host.previewSession({ cwd, agentSessionId });
      }),
  } satisfies Partial<Handlers>;
});
