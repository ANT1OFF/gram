import { mockSessions } from "../mock-depth";
import type { MockWorld } from "../mock-world";
import type { SessionsApi } from "./types";

/** `SessionsApi` over each folder's seeded sessions, marking the ones a thread has open. */
export function createSessionsMock(world: MockWorld): SessionsApi {
  const deleted = new Set<string>();
  return {
    listSessions: async (agent, projectRoot, limit = 50) => {
      await world.delay(20);
      const open = new Map(
        world
          .threads()
          .flatMap(({ thread }) =>
            thread.agentSessionId ? [[thread.agentSessionId, thread.id] as const] : [],
          ),
      );
      const sessions = mockSessions(projectRoot, agent)
        .filter((session) => !deleted.has(session.agentSessionId))
        .slice(0, limit)
        .map((session) => {
          const threadId = open.get(session.agentSessionId);
          return threadId ? { ...session, threadId } : session;
        });
      return { supported: true, sessions };
    },
    deleteSession: async (agent, projectRoot, agentSessionId) => {
      await world.delay(20);
      const shown = world.threads().find(({ thread }) => thread.agentSessionId === agentSessionId);
      if (shown) {
        throw new Error(
          `InvalidState: “${shown.thread.title}” shows this session. Close the thread to delete it.`,
        );
      }
      if (!mockSessions(projectRoot, agent).some((s) => s.agentSessionId === agentSessionId)) {
        throw new Error(`NotFound: session ${agentSessionId}`);
      }
      deleted.add(agentSessionId);
    },
    previewSession: async (agent, projectRoot, agentSessionId) => {
      await world.delay(20);
      const session = mockSessions(projectRoot, agent).find(
        (s) => s.agentSessionId === agentSessionId,
      );
      if (session === undefined) return {};
      return {
        ...(session.firstPrompt === undefined ? {} : { firstPrompt: session.firstPrompt }),
        lastReply: `Done: ${session.title.toLowerCase()}.`,
      };
    },
  };
}
