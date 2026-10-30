import type { GetAccountRateLimitsResponse } from "./protocol/v2/GetAccountRateLimitsResponse.ts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { InitializeParams } from "./protocol/InitializeParams.ts";
import type { InitializeResponse } from "./protocol/InitializeResponse.ts";
import type { RequestId } from "./protocol/RequestId.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";
import type { ConfigBatchWriteParams } from "./protocol/v2/ConfigBatchWriteParams.ts";
import type { ConfigReadParams } from "./protocol/v2/ConfigReadParams.ts";
import type { ConfigReadResponse } from "./protocol/v2/ConfigReadResponse.ts";
import type { ConfigWriteResponse } from "./protocol/v2/ConfigWriteResponse.ts";
import type { ListMcpServerStatusParams } from "./protocol/v2/ListMcpServerStatusParams.ts";
import type { ListMcpServerStatusResponse } from "./protocol/v2/ListMcpServerStatusResponse.ts";
import type { McpServerOauthLoginParams } from "./protocol/v2/McpServerOauthLoginParams.ts";
import type { McpServerOauthLoginResponse } from "./protocol/v2/McpServerOauthLoginResponse.ts";
import type { McpServerRefreshResponse } from "./protocol/v2/McpServerRefreshResponse.ts";
import type { ModelListParams } from "./protocol/v2/ModelListParams.ts";
import type { ModelListResponse } from "./protocol/v2/ModelListResponse.ts";
import type { GetAccountParams } from "./protocol/v2/GetAccountParams.ts";
import type { GetAccountResponse } from "./protocol/v2/GetAccountResponse.ts";
import type { SkillsExtraRootsSetParams } from "./protocol/v2/SkillsExtraRootsSetParams.ts";
import type { SkillsExtraRootsSetResponse } from "./protocol/v2/SkillsExtraRootsSetResponse.ts";
import type { SkillsListParams } from "./protocol/v2/SkillsListParams.ts";
import type { SkillsListResponse } from "./protocol/v2/SkillsListResponse.ts";
import type { ThreadCompactStartParams } from "./protocol/v2/ThreadCompactStartParams.ts";
import type { ThreadCompactStartResponse } from "./protocol/v2/ThreadCompactStartResponse.ts";
import type { ThreadDeleteParams } from "./protocol/v2/ThreadDeleteParams.ts";
import type { ThreadDeleteResponse } from "./protocol/v2/ThreadDeleteResponse.ts";
import type { ThreadForkParams } from "./protocol/v2/ThreadForkParams.ts";
import type { ThreadForkResponse } from "./protocol/v2/ThreadForkResponse.ts";
import type { ThreadListParams } from "./protocol/v2/ThreadListParams.ts";
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse.ts";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.ts";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.ts";
import type { ThreadRevertParams } from "./protocol/v2/ThreadRevertParams.ts";
import type { ThreadRevertResponse } from "./protocol/v2/ThreadRevertResponse.ts";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.ts";
import type { ThreadReadParams } from "./protocol/v2/ThreadReadParams.ts";
import type { ThreadReadResponse } from "./protocol/v2/ThreadReadResponse.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { ThreadTurnsListParams } from "./protocol/v2/ThreadTurnsListParams.ts";
import type { ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse.ts";
import type { TurnInterruptParams } from "./protocol/v2/TurnInterruptParams.ts";
import type { TurnInterruptResponse } from "./protocol/v2/TurnInterruptResponse.ts";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.ts";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.ts";
import type { TurnSteerParams } from "./protocol/v2/TurnSteerParams.ts";
import type { TurnSteerResponse } from "./protocol/v2/TurnSteerResponse.ts";

import type { ThreadUnsubscribeParams } from "./protocol/v2/ThreadUnsubscribeParams.ts";
import type { ThreadUnsubscribeResponse } from "./protocol/v2/ThreadUnsubscribeResponse.ts";

export class CodexRpcError extends Schema.TaggedError<CodexRpcError>()("CodexRpcError", {
  method: Schema.String,
  message: Schema.String,
}) {}

/** The client requests the adapter makes, with their params and results. */
export interface CodexMethods {
  readonly initialize: [InitializeParams, InitializeResponse];
  readonly "model/list": [ModelListParams, ModelListResponse];
  readonly "account/rateLimits/read": [undefined, GetAccountRateLimitsResponse];
  readonly "account/read": [GetAccountParams, GetAccountResponse];
  readonly "mcpServerStatus/list": [ListMcpServerStatusParams, ListMcpServerStatusResponse];
  readonly "mcpServer/oauth/login": [McpServerOauthLoginParams, McpServerOauthLoginResponse];
  readonly "config/mcpServer/reload": [undefined, McpServerRefreshResponse];
  readonly "config/batchWrite": [ConfigBatchWriteParams, ConfigWriteResponse];
  readonly "config/read": [ConfigReadParams, ConfigReadResponse];
  readonly "skills/extraRoots/set": [SkillsExtraRootsSetParams, SkillsExtraRootsSetResponse];
  readonly "thread/unsubscribe": [ThreadUnsubscribeParams, ThreadUnsubscribeResponse];
  readonly "thread/start": [ThreadStartParams, ThreadStartResponse];
  readonly "thread/resume": [ThreadResumeParams, ThreadResumeResponse];
  readonly "thread/fork": [ThreadForkParams, ThreadForkResponse];
  readonly "thread/revert": [ThreadRevertParams, ThreadRevertResponse];
  readonly "thread/list": [ThreadListParams, ThreadListResponse];
  readonly "thread/delete": [ThreadDeleteParams, ThreadDeleteResponse];
  readonly "thread/read": [ThreadReadParams, ThreadReadResponse];
  readonly "thread/turns/list": [ThreadTurnsListParams, ThreadTurnsListResponse];
  readonly "turn/start": [TurnStartParams, TurnStartResponse];
  readonly "turn/steer": [TurnSteerParams, TurnSteerResponse];
  readonly "turn/interrupt": [TurnInterruptParams, TurnInterruptResponse];
  readonly "thread/compact/start": [ThreadCompactStartParams, ThreadCompactStartResponse];
  readonly "skills/list": [SkillsListParams, SkillsListResponse];
}

/** What the server sends besides responses: notifications, and requests the client must answer. */
export type ServerMessage = ServerNotification | ServerRequest;

export const isServerRequest = (message: ServerMessage): message is ServerRequest =>
  "id" in message;

/** One newline-delimited JSON message per line, in both directions. */
export interface CodexIo {
  readonly write: (line: string) => Effect.Effect<void>;
  /** The server's output lines; ends when the process exits. */
  readonly lines: Stream.Stream<string, CodexRpcError>;
}

export interface CodexRpc {
  readonly request: <M extends keyof CodexMethods>(
    method: M,
    params: CodexMethods[M][0],
  ) => Effect.Effect<CodexMethods[M][1], CodexRpcError>;
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void, CodexRpcError>;
  readonly respond: (id: RequestId, result: unknown) => Effect.Effect<void>;
  /** Notifications and server requests in arrival order; ends when the server exits. */
  readonly messages: Stream.Stream<ServerMessage>;
}

interface Incoming {
  readonly id?: RequestId;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

/**
 * JSON-RPC over `codex app-server`'s stdio: app-server omits the `jsonrpc` field. Pending requests
 * fail when the output ends; the reader runs in the caller's scope.
 */
export const makeCodexRpc = (
  io: CodexIo,
  /** Permanent lifecycle observation in wire order, before replies wake callers or listeners queue. */
  observe: (message: ServerMessage) => void = () => {},
): Effect.Effect<CodexRpc, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pending = new Map<
      RequestId,
      { method: string; done: Deferred.Deferred<unknown, CodexRpcError> }
    >();
    const messages = yield* Queue.unbounded<ServerMessage, Cause.Done>();
    let nextId = 0;
    let closed: CodexRpcError | undefined;

    const close = (error: CodexRpcError) =>
      Effect.sync(() => {
        closed = error;
        for (const [id, entry] of pending) {
          pending.delete(id);
          Deferred.doneUnsafe(
            entry.done,
            Effect.fail(new CodexRpcError({ method: entry.method, message: error.message })),
          );
        }
        Queue.endUnsafe(messages);
      });

    const receive = (line: string) =>
      Effect.sync(() => {
        if (line.trim() === "") return;
        let message: Incoming;
        try {
          message = JSON.parse(line) as Incoming;
        } catch {
          return;
        }
        if (message.method !== undefined) {
          observe(message as ServerMessage);
          Queue.offerUnsafe(messages, message as ServerMessage);
          return;
        }
        const entry = message.id === undefined ? undefined : pending.get(message.id);
        if (entry === undefined || message.id === undefined) return;
        pending.delete(message.id);
        Deferred.doneUnsafe(
          entry.done,
          message.error === undefined
            ? Effect.succeed(message.result)
            : Effect.fail(
                new CodexRpcError({
                  method: entry.method,
                  message: message.error.message ?? "request failed",
                }),
              ),
        );
      });

    yield* Effect.forkScoped(
      Stream.runForEach(io.lines, receive).pipe(
        Effect.catch((error) => close(error)),
        Effect.andThen(
          Effect.suspend(() =>
            closed === undefined
              ? close(new CodexRpcError({ method: "", message: "codex app-server exited" }))
              : Effect.void,
          ),
        ),
      ),
    );

    const send = (message: unknown) => io.write(JSON.stringify(message));
    const sendFor = (method: string, message: unknown) =>
      send(message).pipe(
        Effect.catchDefect(() =>
          Effect.fail(
            new CodexRpcError({
              method,
              message: "couldn't write to codex app-server",
            }),
          ),
        ),
      );

    return {
      request: (method, params) =>
        Effect.gen(function* () {
          if (closed !== undefined) {
            return yield* new CodexRpcError({ method, message: closed.message });
          }
          const id = nextId++;
          const done = yield* Deferred.make<unknown, CodexRpcError>();
          pending.set(id, { method, done });
          return (yield* sendFor(method, { id, method, params }).pipe(
            Effect.andThen(Deferred.await(done)),
            // Failed writes and interrupted requests no longer retain an unreachable waiter.
            Effect.ensuring(Effect.sync(() => pending.delete(id))),
          )) as CodexMethods[typeof method][1];
        }),
      notify: (method, params) =>
        sendFor(method, params === undefined ? { method } : { method, params }),
      respond: (id, result) => send({ id, result }),
      messages: Stream.fromQueue(messages),
    } satisfies CodexRpc;
  });
