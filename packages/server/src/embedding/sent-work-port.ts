import { randomUUID } from "node:crypto";

import {
  HOSTED_THREAD_STATES,
  HostedMachine,
  HostedRepositoryReach,
  type HostedThreadWaited,
  type SentWorkBrief,
  type SentWorkOp,
  type SentWorkRequestMessage,
  type SentWorkResponseMessage,
  type SentWorkResult,
  type SentWorkTarget,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

type Refused = { readonly ok: false; readonly why: string; readonly unknown?: true };

export interface SentWorkPortShape {
  /** Whether there is an app to ask at all. */
  readonly available: boolean;
  readonly targets: () => Effect.Effect<
    { readonly ok: true; readonly targets: ReadonlyArray<SentWorkTarget> } | Refused
  >;
  /** Whether a thread there could clone and push each repository. Changes nothing there. */
  readonly check: (
    origin: string,
    workspaceId: string,
    repositories: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly ok: true; readonly reach: HostedRepositoryReach } | Refused>;
  readonly send: (
    origin: string,
    workspaceId: string,
    work: SentWorkBrief,
  ) => Effect.Effect<
    { readonly ok: true; readonly threadId: string; readonly branch?: string } | Refused
  >;
  readonly wait: (
    origin: string,
    workspaceId: string,
    threadId: string,
    wait: {
      readonly after?: string;
      readonly until?: "reply" | "idle" | "waiting" | "message";
      readonly timeoutSeconds?: number;
    },
  ) => Effect.Effect<{ readonly ok: true; readonly waited: HostedThreadWaited } | Refused>;
  readonly message: (
    origin: string,
    workspaceId: string,
    threadId: string,
    message: {
      readonly text: string;
      readonly clientKey: string;
      readonly mode?: "queue" | "steer" | "interrupt";
    },
  ) => Effect.Effect<
    { readonly ok: true; readonly queued: boolean; readonly after?: string } | Refused
  >;
  readonly stop: (
    origin: string,
    workspaceId: string,
    threadId: string,
  ) => Effect.Effect<{ readonly ok: true } | Refused>;
  /**
   * The person's own machine there: read, or started unless it runs. `unoffered`: the server
   * starts none from here. Only for a send the person makes (`embedding/hosted-machine.ts`).
   */
  readonly machine: (
    origin: string,
    workspaceId: string,
    action: "get" | "start",
  ) => Effect.Effect<
    { readonly ok: true; readonly machine: HostedMachine | "unoffered" } | Refused
  >;
}

/** Electron's `process.parentPort` as the server sees it. */
export interface SentWorkMessagePort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): unknown;
}

const NO_APP = "Work is sent to a server only from the Gram desktop app.";
const NO_ANSWER = "The desktop app didn't answer.";

const timeoutFor = (op: SentWorkOp): number =>
  op.op === "send" ? 210_000 : op.op === "wait" ? 60_000 : 45_000;

const isResponse = (message: unknown): message is SentWorkResponseMessage =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "work.response" &&
  typeof (message as { id?: unknown }).id === "string" &&
  typeof (message as { result?: unknown }).result === "object" &&
  (message as { result?: unknown }).result !== null;

const refusedOf = (result: SentWorkResult): Refused =>
  result.ok ? { ok: false, why: "The desktop app's answer isn't one the server reads." } : result;

const isWaited = (waited: unknown): waited is HostedThreadWaited => {
  const thread =
    typeof waited === "object" && waited !== null ? Reflect.get(waited, "thread") : undefined;
  return (
    typeof thread === "object" &&
    thread !== null &&
    (HOSTED_THREAD_STATES as ReadonlyArray<unknown>).includes(Reflect.get(thread, "state"))
  );
};

const isTarget = (target: unknown): target is SentWorkTarget =>
  typeof target === "object" &&
  target !== null &&
  ["origin", "server", "workspaceId", "workspace", "organisation"].every(
    (name) => typeof Reflect.get(target, name) === "string",
  );

/** Requests over `port`, each answered by id, or failed after its time. */
export const bridgeSentWork = (
  port: SentWorkMessagePort,
  timeoutOf: (op: SentWorkOp) => number = timeoutFor,
): SentWorkPortShape => {
  const pending = new Map<string, (result: SentWorkResult) => void>();
  port.on("message", ({ data }) => {
    if (isResponse(data)) pending.get(data.id)?.(data.result);
  });
  const ask = (op: SentWorkOp): Effect.Effect<SentWorkResult> =>
    Effect.callback<SentWorkResult>((resume) => {
      const id = randomUUID();
      const timer = setTimeout(
        () =>
          settle({
            ok: false,
            why: NO_ANSWER,
            ...(op.op === "send" || op.op === "message" ? { unknown: true as const } : {}),
          }),
        timeoutOf(op),
      );
      function settle(result: SentWorkResult) {
        clearTimeout(timer);
        pending.delete(id);
        resume(Effect.succeed(result));
      }
      pending.set(id, settle);
      const message: SentWorkRequestMessage = { type: "work.request", id, ...op };
      port.postMessage(message);
      return Effect.sync(() => {
        clearTimeout(timer);
        pending.delete(id);
      });
    });
  return {
    available: true,
    targets: () =>
      ask({ op: "targets" }).pipe(
        Effect.map((result) =>
          result.ok && "targets" in result && Array.isArray(result.targets)
            ? { ok: true as const, targets: result.targets.filter(isTarget) }
            : refusedOf(result),
        ),
      ),
    check: (origin, workspaceId, repositories) =>
      ask({ op: "check", origin, workspaceId, repositories }).pipe(
        Effect.map((result) => {
          if (!result.ok || !("reach" in result)) return refusedOf(result);
          const reach = Schema.decodeUnknownOption(HostedRepositoryReach)(result.reach);
          return reach._tag === "Some"
            ? { ok: true as const, reach: reach.value }
            : refusedOf({ ok: true });
        }),
      ),
    send: (origin, workspaceId, work) =>
      ask({ op: "send", origin, workspaceId, work }).pipe(
        Effect.map((result) =>
          result.ok && "threadId" in result && typeof result.threadId === "string"
            ? {
                ok: true as const,
                threadId: result.threadId,
                ...(typeof result.branch === "string" ? { branch: result.branch } : {}),
              }
            : result.ok
              ? { ...refusedOf(result), unknown: true as const }
              : result,
        ),
      ),
    wait: (origin, workspaceId, threadId, wait) =>
      ask({ op: "wait", origin, workspaceId, threadId, ...wait }).pipe(
        Effect.map((result) =>
          result.ok && "waited" in result && isWaited(result.waited)
            ? { ok: true as const, waited: result.waited }
            : refusedOf(result),
        ),
      ),
    message: (origin, workspaceId, threadId, message) =>
      ask({ op: "message", origin, workspaceId, threadId, ...message }).pipe(
        Effect.map((result) =>
          result.ok && "queued" in result && typeof result.queued === "boolean"
            ? {
                ok: true as const,
                queued: result.queued,
                ...(typeof result.after === "string" ? { after: result.after } : {}),
              }
            : result.ok
              ? { ...refusedOf(result), unknown: true as const }
              : result,
        ),
      ),
    stop: (origin, workspaceId, threadId) =>
      ask({ op: "stop", origin, workspaceId, threadId }).pipe(
        Effect.map((result) => (result.ok ? { ok: true as const } : result)),
      ),
    machine: (origin, workspaceId, action) =>
      ask({ op: "machine", origin, workspaceId, action }).pipe(
        Effect.map((result) => {
          if (!result.ok || !("machine" in result)) return refusedOf(result);
          if (result.machine === "unoffered") return { ok: true as const, machine: "unoffered" };
          const machine = Schema.decodeUnknownOption(HostedMachine)(result.machine);
          return machine._tag === "Some"
            ? { ok: true as const, machine: machine.value }
            : refusedOf({ ok: true });
        }),
      ),
  };
};

const refusedHere = Effect.succeed({ ok: false as const, why: NO_APP });

/** No desktop app: nothing is sent anywhere. */
export const NO_SENT_WORK: SentWorkPortShape = {
  available: false,
  targets: () => refusedHere,
  check: () => refusedHere,
  send: () => refusedHere,
  wait: () => refusedHere,
  message: () => refusedHere,
  stop: () => refusedHere,
  machine: () => refusedHere,
};

export class SentWorkPort extends Context.Service<SentWorkPort, SentWorkPortShape>()(
  "@gram/server/SentWorkPort",
) {
  /** The desktop app when Electron supplied a parent port; otherwise none. */
  static readonly layer: Layer.Layer<SentWorkPort> = Layer.sync(SentWorkPort, () => {
    const port = (process as { parentPort?: SentWorkMessagePort }).parentPort;
    return port === undefined ? NO_SENT_WORK : bridgeSentWork(port);
  });
}
