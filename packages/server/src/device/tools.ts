import {
  DEVICE_ASK_WAIT_MS,
  DEVICE_LIST_MAX_ENTRIES,
  type DeviceExecEvent,
  type DeviceFolder,
  type DeviceRefusalReason,
  type SignedTurnGrant,
  deviceCommandProblem,
  deviceTimeout,
  type ThreadId,
} from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { defineAppTool, type AppToolDefinition } from "../app-tools/definition.ts";
import { EventSink, type EventSinkShape } from "../embedding/event-sink.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import type { Devices, OnlineDevice } from "./devices.ts";
import { LentDevices } from "./service.ts";
import { type DeviceTurn, type DeviceTurns, LentDeviceTurns } from "./turns.ts";

export const DEVICE_RUN = "device_run";
export const DEVICE_READ_FILE = "device_read_file";
export const DEVICE_LIST_FILES = "device_list_files";

/** How long past the device's own limits this side waits before it gives a request up. */
export const DEVICE_REQUEST_SLACK_MS = 30_000;
/** A read asks for at most this much of a file. */
export const DEVICE_TOOL_READ_BYTES = 256 * 1024;
/** Each of a command's streams is given back to the agent up to this many characters, the end kept. */
export const DEVICE_TOOL_OUTPUT_CHARS = 100_000;

/** Why a request wasn't made or didn't run, as the agent is told it. A fixed set, as the device's. */
export type DeviceToolRefusal =
  | DeviceRefusalReason
  | "no-device-turn"
  | "unknown-folder"
  | "timed-out"
  | "turn-changed";

const SAID: Record<DeviceToolRefusal, string> = {
  "not-allowed-by-person": "The person refused this on their computer.",
  "not-answered": "Nobody answered the ask on the person's computer in time.",
  "no-grant": "The person's computer didn't take this turn's grant.",
  away: "The person's computer isn't connected now.",
  "outside-folders": "That path is outside the folder the person lent.",
  "credential-path": "That path is a credential location, which the computer never lends.",
  "not-a-file": "That path isn't a file (or a folder, for a listing).",
  "too-many-requests": "The person's computer is answering too many requests; wait for one to end.",
  paused: "The person paused lending on their computer.",
  "read-only": "The person lent this computer for reading only; it runs no commands.",
  "too-large": "The command is empty, too long or not plain text.",
  "not-for-this-person": "The person's computer refused a request on another person's behalf.",
  "changed-request": "A request with this id asked something else.",
  "no-device-turn":
    "No computer can be asked in this turn: only a turn started by a message the person sent " +
    "from their desktop app, with this workspace lent, may ask it, and only until that turn ends.",
  "unknown-folder": "The person lent no folder by that name.",
  "timed-out": "The person's computer didn't finish in time; the request was withdrawn.",
  "turn-changed":
    "This turn can no longer ask the computer (it ended, its grant ran out, or other input " +
    "joined it); the request was withdrawn.",
};

const FINAL: ReadonlySet<DeviceToolRefusal> = new Set([
  "not-allowed-by-person",
  "credential-path",
  "outside-folders",
  "not-a-file",
  "read-only",
  "not-for-this-person",
]);

const refused = (why: DeviceToolRefusal, folders?: ReadonlyArray<DeviceFolder>) => ({
  refused: why,
  message: SAID[why] + (FINAL.has(why) ? " Don't ask for the same thing again in this turn." : ""),
  ...(folders === undefined ? {} : { folders: folders.map((folder) => folder.label) }),
});

const keepEnd = (text: string, most: number) =>
  text.length <= most ? text : text.slice(text.length - most);

const relativePath = (path: string | undefined): string | undefined => {
  const trimmed = (path ?? "").trim();
  if (trimmed === "" || trimmed === ".") return "";
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || /^[A-Za-z]:/.test(trimmed))
    return undefined;
  const names = trimmed.split(/[/\\]+/).filter((name) => name !== "" && name !== ".");
  return names.includes("..") ? undefined : names.join("/");
};

const withdraw = (device: OnlineDevice, requestId: string) =>
  device.client["device.cancel"]({ requestId }).pipe(
    Effect.timeout(Duration.seconds(2)),
    Effect.ignore,
  );

/** A file's bytes as text, when they are text: a read cut mid-character keeps what came whole. */
export const fileText = (bytes: Uint8Array, truncated: boolean): string | undefined => {
  if (bytes.includes(0)) return undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let cut = 0; cut <= (truncated ? 3 : 0) && cut <= bytes.length; cut++) {
    try {
      return decoder.decode(bytes.subarray(0, bytes.length - cut));
    } catch {
      continue;
    }
  }
  return undefined;
};

/** What a call reached: the turn, device and folder it may ask, and the path inside, or why not. */
export type DeviceTarget<I> =
  | {
      readonly ok: true;
      readonly input: I;
      readonly turn: DeviceTurn;
      readonly device: OnlineDevice;
      readonly folder: DeviceFolder;
      readonly path: string;
    }
  | { readonly ok: false; readonly result: ReturnType<typeof refused> };

const no = (why: DeviceToolRefusal, folders?: ReadonlyArray<DeviceFolder>) => ({
  ok: false as const,
  result: refused(why, folders),
});

interface RequestBy {
  readonly requestId: string;
  readonly grant: SignedTurnGrant;
  readonly thread: { readonly id: string; readonly title: string };
  readonly actor: { readonly id: string; readonly name: string };
  readonly folderId: string;
}

type Outcome<A> =
  | { readonly kind: "answered"; readonly value: A }
  | { readonly kind: "refused"; readonly why: DeviceRefusalReason }
  | { readonly kind: "gone"; readonly why: "timed-out" | "away" | "turn-changed" };

const decisionOf = <I>(
  kind: "exec" | "read" | "list",
  target: DeviceTarget<I>,
  extra: Record<string, unknown> = {},
) =>
  target.ok
    ? {
        action: "device" as const,
        detail: {
          kind,
          device: target.turn.deviceId,
          person: target.turn.person,
          folder: target.folder.label,
          ...(kind === "exec" ? { cwd: target.path } : { path: target.path }),
          ...extra,
        },
      }
    : undefined;

export interface DeviceToolsDeps {
  readonly devices: Pick<Devices, "ownedBy">;
  readonly turns: Pick<DeviceTurns, "current">;
  readonly store: Pick<ThreadStoreShape, "getThread">;
  readonly sink?: EventSinkShape | undefined;
  /** How often a request under way checks that its turn may still ask; a second by default. */
  readonly recheckEvery?: Duration.Duration;
}

/**
 * `device_run`, `device_read_file` and `device_list_files`: one request to the computer of the
 * person whose message started this turn, from that computer's app (`docs/design/personal-device.md`,
 * "The tools and the turn binding, as built"). Listed on every session that isn't a worker's, and
 * checked at each call: outside such a turn every call is refused with `no-device-turn`, nothing is
 * asked and the decision hook isn't either. Inside one the hook is asked first, with the folder's
 * label and the path as the device will take it, then the person on their computer. A request
 * whose turn stops being able to ask is withdrawn.
 */
export const deviceTools = (deps: DeviceToolsDeps): ReadonlyArray<AppToolDefinition> => {
  const recheckEvery = deps.recheckEvery ?? Duration.seconds(1);

  const record = (
    turn: DeviceTurn,
    type: "device.requested" | "device.answered" | "device.finished",
    data: Record<string, unknown>,
  ) =>
    deps.sink === undefined
      ? Effect.void
      : deps.sink.record({
          type,
          threadId: turn.threadId,
          workspaceId: turn.workspace,
          actor: { kind: "thread", id: turn.threadId, onBehalfOf: turn.person },
          data: { ...data, turnId: turn.turnId },
        });

  const reach = <I extends { readonly folder?: string | undefined }>(
    threadId: ThreadId,
    input: I,
    path: string | undefined,
    needs: "read" | "exec",
  ): Effect.Effect<DeviceTarget<I>> =>
    Effect.gen(function* () {
      const turn = yield* deps.turns.current(threadId);
      if (turn === undefined) return no("no-device-turn");
      const device = deps.devices.ownedBy(turn.person, turn.workspace, turn.deviceId);
      if (device === undefined) return no("away");
      if (!device.hello.capabilities.includes(needs)) return no("read-only");
      const folders = device.hello.folders;
      const named = (input.folder ?? "").trim();
      const byLabel = folders.filter((folder) => folder.label === named);
      const folder =
        folders.find((entry) => entry.id === named) ??
        (byLabel.length === 1
          ? byLabel[0]
          : named === "" && folders.length === 1
            ? folders[0]
            : undefined);
      if (folder === undefined) return no("unknown-folder", folders);
      if (path === undefined) return no("outside-folders");
      return { ok: true, input, turn, device, folder, path };
    });

  const lostTurn = (turn: DeviceTurn) =>
    Effect.gen(function* () {
      while ((yield* deps.turns.current(turn.threadId)) === turn) yield* Effect.sleep(recheckEvery);
      return { kind: "gone", why: "turn-changed" } as const;
    });

  const askWhileBound = <I, A>(
    threadId: ThreadId,
    target: DeviceTarget<I>,
    kind: "exec" | "read" | "list",
    key: string,
    detail: Record<string, unknown>,
    deadlineMs: number,
    send: (by: RequestBy) => Effect.Effect<Outcome<A>, unknown>,
  ): Effect.Effect<
    | (Outcome<A> & { readonly requestId: string })
    | { readonly kind: "not-sent"; readonly result: ReturnType<typeof refused> }
  > =>
    Effect.gen(function* () {
      if (!target.ok) return { kind: "not-sent", result: target.result } as const;
      const { turn, device, folder } = target;
      if ((yield* deps.turns.current(threadId)) !== turn)
        return { kind: "not-sent", result: refused("no-device-turn") } as const;
      const before = turn.refused.get(key);
      if (before !== undefined) return { kind: "not-sent", result: refused(before) } as const;
      const requestId = randomUUID();
      const title = yield* deps.store.getThread(threadId).pipe(
        Effect.map((thread) => thread.title ?? ""),
        Effect.orElseSucceed(() => ""),
      );
      const startedAt = Date.now();
      yield* record(turn, "device.requested", {
        requestId,
        deviceId: turn.deviceId,
        threadId,
        kind,
        folder: folder.label,
        ...detail,
      });
      const outcome = yield* Effect.raceFirst(
        send({
          requestId,
          grant: turn.grant,
          thread: { id: threadId, title: [...title].slice(0, 200).join("") },
          actor: {
            id: turn.person,
            name: [...device.owner.name].slice(0, 120).join(""),
          },
          folderId: folder.id,
        }).pipe(
          Effect.timeoutOption(Duration.millis(deadlineMs)),
          Effect.map((answer) =>
            Option.getOrElse(answer, () => ({ kind: "gone", why: "timed-out" }) as const),
          ),
          Effect.orElseSucceed(() => ({ kind: "gone", why: "away" }) as const),
        ),
        lostTurn(turn),
      ).pipe(Effect.onInterrupt(() => withdraw(device, requestId)));
      if (outcome.kind === "gone") yield* withdraw(device, requestId);
      if (outcome.kind === "refused" && FINAL.has(outcome.why)) turn.refused.set(key, outcome.why);
      yield* record(turn, "device.answered", {
        requestId,
        allowed: outcome.kind === "answered",
        ...(outcome.kind === "answered" ? {} : { why: outcome.why }),
        ms: Date.now() - startedAt,
      });
      return { ...outcome, requestId };
    });

  const run = defineAppTool({
    descriptor: {
      name: DEVICE_RUN,
      class: "outwardGated",
      description:
        "Run one command on the computer of the person who sent this turn's message, in a folder " +
        "they lent: `folder` is its name, `cwd` a path inside it, `reason` why you need it, shown " +
        "to them. They are asked on their computer every time and see the command exactly; a " +
        "refusal is final for this turn. Works only in a turn the person started from their " +
        "desktop app, for ten minutes from their message, and the computer may go offline at any " +
        "time. `timeoutSeconds` is at most 600 and never past those ten minutes.",
    },
    input: Schema.Struct({
      folder: Schema.optionalKey(Schema.String),
      cwd: Schema.optionalKey(Schema.String),
      command: Schema.String,
      reason: Schema.String,
      timeoutSeconds: Schema.optionalKey(Schema.Int),
    }),
    audience: ["plain", "orchestrator"],
    resolve: (threadId, input) =>
      deviceCommandProblem(input.command) !== undefined
        ? Effect.succeed(no("too-large"))
        : reach(threadId, input, relativePath(input.cwd), "exec"),
    decision: (_threadId, target) =>
      decisionOf("exec", target, target.ok ? { command: target.input.command } : {}),
    handle: (threadId, target) =>
      Effect.gen(function* () {
        if (!target.ok) return target.result;
        const { input, device, path: cwd } = target;
        const timeoutMs = Math.min(
          deviceTimeout(
            input.timeoutSeconds === undefined ? undefined : input.timeoutSeconds * 1000,
          ),
          Math.max(1_000, target.turn.grant.grant.expiresAt - Date.now()),
        );
        const out = { stdout: "", stderr: "" };
        let exit: Extract<DeviceExecEvent, { kind: "exit" }> | undefined;
        const outcome = yield* askWhileBound(
          threadId,
          target,
          "exec",
          JSON.stringify(["exec", target.folder.id, cwd, input.command]),
          { cwd, command: input.command },
          timeoutMs + DEVICE_ASK_WAIT_MS + DEVICE_REQUEST_SLACK_MS,
          (by) =>
            Effect.gen(function* () {
              let why: DeviceRefusalReason | undefined;
              let started = false;
              yield* device.client["device.exec"]({
                ...by,
                command: input.command,
                timeoutMs,
                reason: [...input.reason].slice(0, 1000).join(""),
                ...(cwd === "" ? {} : { cwd }),
              }).pipe(
                Stream.runForEach((event) =>
                  Effect.sync(() => {
                    if (event.kind === "started") started = true;
                    else if (event.kind === "output")
                      out[event.stream] = keepEnd(
                        out[event.stream] + event.text,
                        DEVICE_TOOL_OUTPUT_CHARS,
                      );
                    else if (event.kind === "exit") exit = event;
                    else if (event.kind === "refused") why = event.why;
                  }),
                ),
              );
              if (why !== undefined) return { kind: "refused", why } as const;
              return started && exit !== undefined
                ? ({ kind: "answered", value: exit } as const)
                : ({ kind: "gone", why: "away" } as const);
            }),
        );
        if (outcome.kind === "not-sent") return outcome.result;
        if (outcome.kind === "refused") return refused(outcome.why);
        if (outcome.kind === "gone") {
          yield* record(target.turn, "device.finished", {
            requestId: outcome.requestId,
            truncated: false,
            timedOut: outcome.why === "timed-out",
            ended: outcome.why,
          });
          return { ...refused(outcome.why), stdout: out.stdout, stderr: out.stderr };
        }
        const ended = outcome.value;
        yield* record(target.turn, "device.finished", {
          requestId: outcome.requestId,
          ...(ended.code === undefined ? {} : { code: ended.code }),
          ...(ended.signal === undefined ? {} : { signal: ended.signal }),
          truncated: ended.truncated,
          timedOut: ended.timedOut,
          bytes: out.stdout.length + out.stderr.length,
        });
        return {
          ...(ended.code === undefined ? {} : { exitCode: ended.code }),
          ...(ended.signal === undefined ? {} : { signal: ended.signal }),
          stdout: out.stdout,
          stderr: out.stderr,
          ...(ended.truncated ? { truncated: true } : {}),
          ...(ended.timedOut ? { timedOut: true } : {}),
        };
      }),
  });

  const read = defineAppTool({
    descriptor: {
      name: DEVICE_READ_FILE,
      class: "outwardGated",
      description:
        "Read one file on the computer of the person who sent this turn's message, in a folder " +
        "they lent: `folder` is its name and `path` a path inside it. They are asked on their " +
        "computer every time; a refusal is final for this turn. Text comes back as text, up to " +
        "256 KiB. Works only in a turn the person started from their desktop app.",
    },
    input: Schema.Struct({ folder: Schema.optionalKey(Schema.String), path: Schema.String }),
    audience: ["plain", "orchestrator"],
    resolve: (threadId, input) => {
      const path = relativePath(input.path);
      return reach(threadId, input, path === "" ? undefined : path, "read");
    },
    decision: (_threadId, target) => decisionOf("read", target),
    handle: (threadId, target) =>
      Effect.gen(function* () {
        if (!target.ok) return target.result;
        const { device, path } = target;
        const outcome = yield* askWhileBound(
          threadId,
          target,
          "read",
          JSON.stringify(["read", target.folder.id, path]),
          { path },
          DEVICE_ASK_WAIT_MS + DEVICE_REQUEST_SLACK_MS,
          (by) =>
            device.client["device.files.read"]({
              ...by,
              path,
              maxBytes: DEVICE_TOOL_READ_BYTES,
            }).pipe(
              Effect.map((answer) =>
                answer.kind === "refused"
                  ? ({ kind: "refused", why: answer.why } as const)
                  : ({ kind: "answered", value: answer } as const),
              ),
            ),
        );
        if (outcome.kind === "not-sent") return outcome.result;
        if (outcome.kind !== "answered") return refused(outcome.why);
        const bytes = Buffer.from(outcome.value.data, "base64");
        const text = fileText(bytes, outcome.value.truncated);
        const cut = outcome.value.truncated ? { truncated: true } : {};
        return text === undefined
          ? { binary: true, bytes: bytes.length, ...cut }
          : { text, ...cut };
      }),
  });

  const list = defineAppTool({
    descriptor: {
      name: DEVICE_LIST_FILES,
      class: "outwardGated",
      description:
        "List a folder on the computer of the person who sent this turn's message. With no " +
        "`folder`, names the folders they lent, asking nothing. With one, lists `path` inside it " +
        "(its top when absent); they are asked on their computer each time. Works only in a turn " +
        "the person started from their desktop app.",
    },
    input: Schema.Struct({
      folder: Schema.optionalKey(Schema.String),
      path: Schema.optionalKey(Schema.String),
    }),
    audience: ["plain", "orchestrator"],
    resolve: (threadId, input) => reach(threadId, input, relativePath(input.path), "read"),
    decision: (_threadId, target) =>
      target.ok && target.input.folder !== undefined ? decisionOf("list", target) : undefined,
    handle: (threadId, target) =>
      Effect.gen(function* () {
        if (!target.ok) return target.result;
        const { device, path } = target;
        if (target.input.folder === undefined)
          return {
            folders: device.hello.folders.map((folder) => folder.label),
            runs: device.hello.capabilities.includes("exec"),
          };
        const outcome = yield* askWhileBound(
          threadId,
          target,
          "list",
          JSON.stringify(["list", target.folder.id, path]),
          { path },
          DEVICE_ASK_WAIT_MS + DEVICE_REQUEST_SLACK_MS,
          (by) =>
            device.client["device.files.list"]({
              ...by,
              path,
              limit: DEVICE_LIST_MAX_ENTRIES,
            }).pipe(
              Effect.map((answer) =>
                answer.kind === "refused"
                  ? ({ kind: "refused", why: answer.why } as const)
                  : ({ kind: "answered", value: answer } as const),
              ),
            ),
        );
        if (outcome.kind === "not-sent") return outcome.result;
        if (outcome.kind !== "answered") return refused(outcome.why);
        const entries = outcome.value.entries.slice(0, DEVICE_LIST_MAX_ENTRIES);
        return {
          entries,
          ...(outcome.value.truncated || entries.length < outcome.value.entries.length
            ? { truncated: true }
            : {}),
        };
      }),
  });

  return [run, read, list];
};

/** Registers the device tools where people lend devices to this server, and nowhere else. */
export const DeviceToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const devices = yield* LentDevices;
    const turns = yield* LentDeviceTurns;
    if (devices === undefined || turns === undefined) return;
    const sink = Option.getOrUndefined(yield* Effect.serviceOption(EventSink));
    yield* (yield* AppToolRegistry).register(
      deviceTools({ devices, turns, store: yield* ThreadStore, sink }),
    );
  }),
);

/**
 * The lent devices, their turns and their tools, for the server's routes: none of it where nobody
 * signs in through a front.
 */
export const LentDevicesLive = DeviceToolsLive.pipe(
  Layer.provideMerge(LentDeviceTurns.layer),
  Layer.provideMerge(LentDevices.layer),
);
