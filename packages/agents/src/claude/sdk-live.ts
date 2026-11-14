import {
  archiveSession,
  createSdkMcpServer,
  deleteSession,
  getSessionMessages,
  importSessionToStore,
  listSessions,
  query,
  tool,
  unarchiveSession,
} from "@anthropic-ai/claude-agent-sdk";
import * as Layer from "effect/Layer";
import { CLAUDE_AGENT_SDK_VERSION, ClaudeSdk } from "./sdk.ts";

export const ClaudeSdkLive: Layer.Layer<ClaudeSdk> = Layer.succeed(ClaudeSdk)({
  query,
  listSessions,
  deleteSession,
  archiveSession,
  unarchiveSession,
  getSessionMessages,
  importSessionToStore,
  tool,
  createSdkMcpServer,
  version: CLAUDE_AGENT_SDK_VERSION,
});
