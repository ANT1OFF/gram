import type { ThreadId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLaunchToken, MCP_PATH, tokensEqual } from "../http/auth.ts";
import { HttpServer } from "../platform/unstable.ts";

/** What a non-Claude agent host needs to reach the app-tool MCP server for one thread. */
export interface McpConnection {
  readonly url: string;
  readonly headers: { readonly authorization: string };
}

const mcpConnection = (port: number, token: string): McpConnection => ({
  url: `http://127.0.0.1:${port}${MCP_PATH}`,
  headers: { authorization: `Bearer ${token}` },
});

/** Per-thread bearer tokens for the HTTP MCP transport. In memory: a restart revokes all. */
export class McpTokens extends Context.Service<
  McpTokens,
  {
    /** A random 256-bit hex token for the thread; the same one until it's revoked. */
    readonly issue: (threadId: ThreadId) => Effect.Effect<string>;
    /** The thread a token was issued for, compared in constant time; `undefined` if none. */
    readonly threadFor: (token: string) => Effect.Effect<ThreadId | undefined>;
    /** Live identity for this exact token generation; revocation aborts its active requests. */
    readonly authorizationFor: (
      token: string,
    ) => Effect.Effect<{ readonly threadId: ThreadId; readonly signal: AbortSignal } | undefined>;
    readonly revoke: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("@gram/server/McpTokens") {
  static readonly layer = Layer.sync(McpTokens, () => {
    const byThread = new Map<ThreadId, { token: string; controller: AbortController }>();
    const authorizationFor = (token: string) =>
      Effect.sync(() => {
        let found: { threadId: ThreadId; signal: AbortSignal } | undefined;
        // As with threadFor, no early exit reveals which entry matched.
        for (const [threadId, candidate] of byThread) {
          if (tokensEqual(candidate.token, token))
            found = { threadId, signal: candidate.controller.signal };
        }
        return found;
      });
    return McpTokens.of({
      issue: (threadId) =>
        Effect.sync(() => {
          const existing = byThread.get(threadId);
          if (existing !== undefined) return existing.token;
          const token = makeLaunchToken();
          byThread.set(threadId, { token, controller: new AbortController() });
          return token;
        }),
      threadFor: (token) =>
        authorizationFor(token).pipe(Effect.map((identity) => identity?.threadId)),
      authorizationFor,
      revoke: (threadId) =>
        Effect.sync(() => {
          byThread.get(threadId)?.controller.abort();
          byThread.delete(threadId);
        }),
    });
  });
}

/** Issues (or reuses) the thread's token and returns the connection info for its agent host. */
export const mcpConnectionFor = (
  threadId: ThreadId,
): Effect.Effect<McpConnection, never, McpTokens | HttpServer.HttpServer> =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const token = yield* (yield* McpTokens).issue(threadId);
    return mcpConnection("port" in server.address ? server.address.port : 0, token);
  });
