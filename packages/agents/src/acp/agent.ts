import {
  AgentUnavailable,
  type AgentCapabilities,
  type AgentKind,
  type MessageId,
  type ModelRef,
  type PermissionMode,
  type SlashCommand,
} from "@gram/contracts";
import type * as Effect from "effect/Effect";

import type { AgentConnectors, OpenSessionOptions, OutwardGate } from "../host.ts";
import type { AcpConnection, StartAcpAgent } from "./connection.ts";
import type { Json } from "./json.ts";
import type { AcpMapper } from "./mapper.ts";

/** Where an ACP agent runs, and how it starts; tests stand in `start`. */
export interface AcpHostConfig {
  /** The agent's executable; fails when it isn't installed. */
  readonly binary: Effect.Effect<string, AgentUnavailable>;
  /** The user's login-shell environment, which the CLI runs in. */
  readonly env: Effect.Effect<Readonly<Record<string, string | undefined>>>;
  /** Arguments after the agent's own, such as where its config lives. */
  readonly args?: Effect.Effect<ReadonlyArray<string>>;
  /** Starts an agent process; tests stand one in. */
  readonly start: (input: StartAcpAgent) => AcpConnection;
  readonly newMessageId: () => MessageId;
}

/** What an ACP agent's own part of a session starts from, once the session is open. */
export interface AcpOpened {
  readonly connection: AcpConnection;
  readonly sessionId: string;
  /** The answer to `session/new`, `session/resume` or `session/load`. */
  readonly opened: Json;
  readonly options: OpenSessionOptions;
  readonly mode: PermissionMode;
  readonly gate: OutwardGate | undefined;
  readonly mapper: AcpMapper;
  /** A request whose failure fails the session's start with `what`. */
  call<T = unknown>(
    what: string,
    method: string,
    params: Record<string, unknown>,
  ): Effect.Effect<T, AgentUnavailable>;
}

/** The agent's own controls of an open session. */
export interface AcpControls {
  /** The model the session runs on now. */
  readonly model: string;
  /** Moves the session from `from` into `next`; rejects when the agent won't. */
  setMode(next: PermissionMode, from: PermissionMode): Promise<void>;
  setModel(model: ModelRef): Effect.Effect<void, AgentUnavailable>;
  readonly connectors?: AgentConnectors;
  /** Gives the agent a message mid-turn; absent when it takes one only by stopping the turn. */
  interject?(content: ReadonlyArray<Json>, plain: string): Promise<unknown>;
}

/** One ACP agent as Gram drives it: its names, how it starts, and what it does its own way. */
export interface AcpAgentSpec {
  readonly kind: AgentKind;
  /** The agent's name in what Gram says, such as "Grok Build". */
  readonly name: string;
  readonly capabilities: AgentCapabilities;
  /** The arguments every agent process starts with. */
  readonly args: ReadonlyArray<string>;
  /** What a failed start or session says when the CLI has no usable sign-in. */
  readonly signInMessage: string;
  /** What the agent's errors say when it has no usable sign-in; `SIGN_IN_PATTERN` by default. */
  readonly signInPattern?: RegExp;
  /**
   * The connection the session uses, signing in headless where the environment says how, and
   * telling `notice` what the person should know about the sign-in it fell back on.
   */
  readonly signIn: (
    connection: AcpConnection,
    env: Readonly<Record<string, string | undefined>>,
    notice: (message: string) => void,
  ) => AcpConnection;
  /**
   * Why the agent mustn't run in these folders (the first is its working folder), if it mustn't:
   * checked before each agent process starts and before each turn.
   */
  readonly refuses?: (dirs: ReadonlyArray<string>) => string | undefined;
  /** Notifications that carry `session/update`s. */
  readonly updateMethods: ReadonlyArray<string>;
  readonly commandsOf: (update: Json) => ReadonlyArray<SlashCommand>;
  /** The session's mapper, given the name Gram's app tools server took in it. */
  readonly mapper: (
    sessionId: string,
    newMessageId: () => MessageId,
    appToolsServer: string,
  ) => AcpMapper;
  /** The name Gram's app tools server takes in a session the agent runs. */
  readonly appToolsServer: () => string;
  /** Gram's own answer to a permission request, or `undefined` for a card. */
  readonly autoAnswer: (
    mode: PermissionMode,
    gate: OutwardGate | undefined,
    call: Json,
    roots: ReadonlyArray<string>,
    appToolsServer: string,
  ) => "allow" | "deny" | undefined;
  /** What `session/new`, `session/resume` and `session/load` carry beside the folder and servers. */
  readonly sessionParams: (options: OpenSessionOptions) => Json;
  /** A replayed call's name in a past session's transcript. */
  readonly transcriptToolName: (update: Json) => string;
  /** `session/load` answers for any id, so a replay with nothing in it is a session never had. */
  readonly loadAnswersAnyId?: boolean;
  /** Puts the open session in the thread's mode and model, and reads the agent's own controls. */
  readonly setUp: (opened: AcpOpened) => Effect.Effect<AcpControls, AgentUnavailable>;
}

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What an agent's error says when it has no usable sign-in. */
export const SIGN_IN_PATTERN = /auth|sign[ -]?in|log ?in|unauthori[sz]ed|credential|token expired/i;

/** Whether `message`, from `spec`'s agent, says it has no usable sign-in. */
export const signInProblem = (spec: AcpAgentSpec, message: string): boolean =>
  (spec.signInPattern ?? SIGN_IN_PATTERN).test(message);

/** A failure of `spec`'s agent, read as a sign-in problem where it is one. */
export const acpFailure = (spec: AcpAgentSpec, what: string, error: unknown) => {
  const message = messageOf(error);
  return new AgentUnavailable({
    agent: spec.kind,
    message: signInProblem(spec, message) ? spec.signInMessage : `${what}: ${message}`,
  });
};

const CLIENT_INFO = { name: "gram", version: "1" } as const;

export const INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: CLIENT_INFO,
};
