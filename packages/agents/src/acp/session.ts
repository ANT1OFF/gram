import {
  AgentUnavailable,
  AnswerUndelivered,
  ModeRefused,
  RequestId,
  type AgentEvent,
  type PermissionMode,
  type RequestAnswer,
  type SlashCommand,
  type UserInput,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";

import type { AgentSession, OpenSessionOptions } from "../host.ts";
import { gateLevel } from "../outward.ts";
import {
  acpFailure,
  INITIALIZE_PARAMS,
  messageOf,
  signInProblem,
  type AcpAgentSpec,
  type AcpHostConfig,
} from "./agent.ts";
import { AcpError, type AcpHandlers } from "./connection.ts";
import { promptOf } from "./content.ts";
import { type Json, record, text } from "./json.ts";
import type { AcpMapper } from "./mapper.ts";
import { offeredOptions, optionFor, type PermissionOption } from "./permissions.ts";

/** Starts `spec`'s agent in `cwd`, connected through `handlers` and signed in as its env says. */
export const launchAcp = (
  config: AcpHostConfig,
  spec: AcpAgentSpec,
  cwd: string,
  handlers: AcpHandlers,
) =>
  Effect.gen(function* () {
    const binary = yield* config.binary;
    const env = yield* config.env;
    const extra = config.args === undefined ? [] : yield* config.args;
    return yield* Effect.try({
      try: () =>
        spec.signIn(
          config.start({ binary, args: [...spec.args, ...extra], env, cwd, handlers }),
          env,
        ),
      catch: (error) => acpFailure(spec, `${spec.name} didn't start`, error),
    });
  });

/** Gram's app tools, and the session's own server, as ACP's `mcpServers`. */
const mcpServersOf = (options: OpenSessionOptions, appToolsServer: string) => [
  ...(options.mcp === undefined
    ? []
    : [
        {
          type: "http",
          name: appToolsServer,
          url: options.mcp.url,
          headers: Object.entries(options.mcp.headers).map(([name, value]) => ({ name, value })),
        },
      ]),
  ...(options.mcpServer === undefined
    ? []
    : [{ type: "http", name: options.mcpServer.name, url: options.mcpServer.url, headers: [] }]),
];

/**
 * A thread's session on `spec`'s agent: one agent process of its own, driven over the Agent Client
 * Protocol. The agent keeps the session; Gram resumes it by id.
 */
export const openAcpSession = (
  config: AcpHostConfig,
  spec: AcpAgentSpec,
  options: OpenSessionOptions,
) =>
  Effect.gen(function* () {
    const name = spec.name;
    const unavailable = (message: string) => new AgentUnavailable({ agent: spec.kind, message });
    if (options.dreamFilesOnly === true || options.confineWrites === true)
      return yield* Effect.fail(
        unavailable(`${name} can't keep a session's writes, shell and network bounded.`),
      );
    if (options.model?.profileId !== undefined)
      return yield* Effect.fail(unavailable(`${name} runs on its own sign-in, not a gateway.`));

    const events = yield* Queue.unbounded<AgentEvent>();
    const emit = (out: ReadonlyArray<AgentEvent>) => {
      for (const event of out) Queue.offerUnsafe(events, event);
    };
    let sessionId: string | undefined;
    let mapper: AcpMapper | undefined;
    let mode: PermissionMode = options.permissionMode ?? "default";
    const gate = gateLevel(options.outwardGate);
    const roots = [options.cwd, ...(options.additionalDirectories ?? [])];
    const appToolsServer = spec.appToolsServer();
    const pending = new Map<
      RequestId,
      { options: ReadonlyArray<PermissionOption>; answer: (result: Json) => void }
    >();

    let commands: ReadonlyArray<SlashCommand> = [];
    let identity: Extract<AgentEvent, { type: "identity" }> | undefined;
    const onUpdate = (params: Json) => {
      const update = record(params["update"]);
      if (update["sessionUpdate"] === "available_commands_update") {
        commands = spec.commandsOf(update);
        if (identity !== undefined) {
          identity = { ...identity, commands };
          Queue.offerUnsafe(events, identity);
        }
        return;
      }
      if (mapper === undefined) return;
      if (text(params["sessionId"]) !== sessionId) return;
      emit(mapper.update(update));
    };

    const handlers: AcpHandlers = {
      notification: (method, params) => {
        if (spec.updateMethods.includes(method)) onUpdate(params);
      },
      request: (method, params) => {
        if (method !== "session/request_permission")
          return Promise.reject(new AcpError(-32601, `${method} is not supported`));
        const call = record(params["toolCall"]);
        const offered = offeredOptions(params);
        const own = spec.autoAnswer(mode, gate, call, roots, appToolsServer);
        if (own !== undefined) {
          const option = optionFor(offered, own, "once");
          return Promise.resolve(
            option === undefined
              ? { outcome: { outcome: "cancelled" } }
              : { outcome: { outcome: "selected", optionId: option.optionId } },
          );
        }
        return new Promise((resolve) => {
          const requestId = RequestId.make(randomUUID());
          pending.set(requestId, { options: offered, answer: resolve });
          if (mapper !== undefined) emit(mapper.permission(requestId, params));
        });
      },
    };

    const connection = yield* launchAcp(config, spec, options.cwd, handlers);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const each of pending.values()) each.answer({ outcome: { outcome: "cancelled" } });
        pending.clear();
        await connection.stop();
      }),
    );

    const call = <T = unknown>(what: string, method: string, params: Record<string, unknown>) =>
      Effect.tryPromise({
        try: () => connection.request<T>(method, params),
        catch: (error) => acpFailure(spec, what, error),
      });

    const initialized = record(
      yield* call(`${name} didn't start`, "initialize", INITIALIZE_PARAMS),
    );
    const capabilities = record(initialized["agentCapabilities"]);
    const base = {
      cwd: options.cwd,
      mcpServers: mcpServersOf(options, appToolsServer),
      ...spec.sessionParams(options),
    };
    let opened: Json;
    if (options.resumeId !== undefined) {
      const resumable = record(capabilities["sessionCapabilities"])["resume"] !== undefined;
      opened = record(
        yield* call(
          `Couldn't resume the ${name} session`,
          resumable ? "session/resume" : "session/load",
          { ...base, sessionId: options.resumeId },
        ),
      );
      sessionId = options.resumeId;
    } else {
      opened = record(yield* call(`Couldn't start a ${name} session`, "session/new", base));
      sessionId = text(opened["sessionId"]);
      if (sessionId === undefined)
        return yield* Effect.fail(unavailable(`${name} didn't name its session.`));
    }
    const id = sessionId;
    mapper = spec.mapper(id, config.newMessageId, appToolsServer);
    const current = mapper;
    const controls = yield* spec.setUp({
      connection,
      sessionId: id,
      opened,
      options,
      mode,
      gate,
      mapper: current,
      call,
    });

    identity = { type: "identity", agentSessionId: id, model: controls.model, tools: [], commands };
    Queue.offerUnsafe(events, identity);

    let turn: Promise<void> | undefined;
    const prompt = (input: UserInput) => {
      emit(current.started());
      const running = promptOf(input)
        .then((content) => connection.request("session/prompt", { sessionId: id, prompt: content }))
        .then(
          (result) =>
            emit(current.ended(text(record(result)["stopReason"]), undefined, record(result))),
          (error: unknown) => {
            const message = messageOf(error);
            emit(
              current.ended(undefined, signInProblem(spec, message) ? spec.signInMessage : message),
            );
          },
        );
      turn = running;
      void running.finally(() => {
        if (turn === running) turn = undefined;
      });
      return running;
    };

    void connection.ended.then((reason) => {
      for (const each of pending.values()) each.answer({ outcome: { outcome: "cancelled" } });
      pending.clear();
      Queue.offerUnsafe(events, { type: "ended", reason });
    });

    const cancel = () => {
      for (const [requestId, each] of pending) {
        each.answer({ outcome: { outcome: "cancelled" } });
        emit(current.resolved(requestId));
      }
      pending.clear();
      connection.notify("session/cancel", { sessionId: id });
    };

    const quietly = (what: string, run: () => Promise<unknown>) =>
      Effect.promise(() =>
        run().then(
          () => undefined,
          (error: unknown) => {
            Queue.offerUnsafe(events, {
              type: "notice",
              level: "error",
              message: `${what}: ${messageOf(error)}`,
            });
          },
        ),
      );

    const interject = controls.interject;
    const agentSession: AgentSession = {
      events: Stream.fromQueue(events),
      send: (input) =>
        Effect.sync(() => {
          void prompt(input);
        }),
      steer: (input, steerOptions) =>
        steerOptions?.interrupt === true || turn === undefined || interject === undefined
          ? quietly(`${name} didn't stop for the message`, async () => {
              if (turn !== undefined) {
                cancel();
                await turn;
              }
              void prompt(input);
            })
          : quietly(`${name} didn't take the message`, async () =>
              interject([...(await promptOf(input))], input.text),
            ),
      interrupt: Effect.sync(cancel),
      respond: (requestId, answer: RequestAnswer) => {
        const waiting = pending.get(requestId);
        if (waiting === undefined)
          return Effect.fail(new AnswerUndelivered({ message: `${name} isn't asking that now.` }));
        if (answer.kind !== "approval")
          return Effect.fail(
            new AnswerUndelivered({ message: `${name} only asks for approvals.` }),
          );
        const option = optionFor(
          waiting.options,
          answer.decision === "deny" ? "deny" : "allow",
          answer.decision === "deny" ? undefined : answer.scope,
        );
        if (option === undefined)
          return Effect.fail(
            new AnswerUndelivered({ message: `${name} offered no option for that answer.` }),
          );
        pending.delete(requestId);
        waiting.answer({ outcome: { outcome: "selected", optionId: option.optionId } });
        emit(current.resolved(requestId));
        return Effect.void;
      },
      setMode: (next) =>
        Effect.tryPromise({
          try: async () => {
            await controls.setMode(next, mode);
            mode = next;
          },
          catch: (error) =>
            new ModeRefused({
              mode: next,
              message: `${name} didn't change mode: ${messageOf(error)}`,
            }),
        }).pipe(Effect.tap(() => Queue.offer(events, { type: "mode", mode: next }))),
      setModel: (next) =>
        controls.setModel(next).pipe(
          Effect.catch((error) =>
            Queue.offer(events, { type: "notice", level: "error", message: error.message }),
          ),
          Effect.asVoid,
        ),
      processId: Effect.succeed(connection.pid),
      ...(controls.connectors === undefined ? {} : { connectors: controls.connectors }),
    };
    return agentSession;
  });
