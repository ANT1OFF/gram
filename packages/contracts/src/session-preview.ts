import * as Schema from "effect/Schema";
import { AgentKind } from "./domain.ts";

/** `sessions.preview`: one past session of `agent` for `projectRoot`, as `sessions.list` returned it. */
export const SessionPreviewPayload = Schema.Struct({
  agent: AgentKind,
  projectRoot: Schema.String,
  agentSessionId: Schema.String,
});
export type SessionPreviewPayload = typeof SessionPreviewPayload.Type;

/** How a past session began and ended, each on one trimmed line; absent where there's no text. */
export const SessionPreview = Schema.Struct({
  firstPrompt: Schema.optionalKey(Schema.String),
  lastReply: Schema.optionalKey(Schema.String),
});
export type SessionPreview = typeof SessionPreview.Type;
