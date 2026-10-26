import * as Schema from "effect/Schema";
import { AgentKind } from "./domain.ts";

// Resume depth: deleting past sessions.

/** A past session of `agent` for `projectRoot`, as `sessions.list` returned it. */
export const DeleteSessionPayload = Schema.Struct({
  agent: AgentKind,
  projectRoot: Schema.String,
  agentSessionId: Schema.String,
});
export type DeleteSessionPayload = typeof DeleteSessionPayload.Type;
