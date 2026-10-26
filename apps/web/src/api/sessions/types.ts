import type { AgentKind, AgentSessionList, SessionPreview } from "@gram/contracts";

/** `sessions.*`: the agents' past sessions in a folder, to resume, preview or delete. */
export interface SessionsApi {
  /** An agent's past sessions for a folder, newest first; `supported` is false when it can't list them. */
  listSessions(agent: AgentKind, projectRoot: string, limit?: number): Promise<AgentSessionList>;
  /** Deletes a past session from the agent's history; rejects while a thread shows it. */
  deleteSession(agent: AgentKind, projectRoot: string, agentSessionId: string): Promise<void>;
  /** A past session's first prompt and last reply, reading only that session. */
  previewSession(
    agent: AgentKind,
    projectRoot: string,
    agentSessionId: string,
  ): Promise<SessionPreview>;
}
