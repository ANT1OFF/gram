import type {
  deleteSession,
  getSessionMessages,
  importSessionToStore,
  listSessions,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import * as Context from "effect/Context";
import type { McpServerFactory } from "./apptools.ts";

/**
 * The pinned Agent SDK version, for the CLI/SDK skew check. A constant rather than a package.json
 * lookup, which the desktop's CommonJS bundle can't resolve; `sdk.test.ts` keeps it in sync.
 */
export const CLAUDE_AGENT_SDK_VERSION = "0.3.302";

export interface ClaudeSdkShape extends McpServerFactory {
  readonly query: typeof query;
  /** Reads the local session transcripts; a host without it lists no past sessions. */
  readonly listSessions?: typeof listSessions;
  /** Removes a local session transcript; a host without it can't delete past sessions. */
  readonly deleteSession?: typeof deleteSession;
  /** Reads one local session transcript; a host without it previews no past sessions. */
  readonly getSessionMessages?: typeof getSessionMessages;
  /** Streams a local session transcript's raw entries; a host without it reads no saved cost. */
  readonly importSessionToStore?: typeof importSessionToStore;
  /** The installed Agent SDK version, e.g. `0.3.273`. */
  readonly version: string;
}

/** The Agent SDK's entry points, as a service so tests can drive a fake `query`. */
export class ClaudeSdk extends Context.Service<ClaudeSdk, ClaudeSdkShape>()(
  "@gram/agents/ClaudeSdk",
) {}
