import {
  DEVICE_ASK_WAIT_MS,
  type DeviceApproval,
  type DeviceCapability,
  type DeviceExecEvent,
  type DeviceListResult,
  type DeviceReadResult,
  type DeviceRefusalReason,
  type SignedTurnGrant,
  type CommandDisplay,
  deviceCommandProblem,
  deviceTimeout,
  displayCommand,
} from "@gram/contracts";
import type { DeviceLogEntry } from "./log.ts";
import type { GrantLedger } from "./grants.ts";
import type { AskLimits, AskOutcome } from "./limits.ts";
import {
  type LentFolder,
  listLentFolder,
  readLentFile,
  resolveLentFile,
  resolveLentFolder,
  resolveWorkingFolder,
} from "./folders.ts";
import { approvalHash, sameHash } from "./keys.ts";
import { type CommandResult, runCommand } from "./runner.ts";

/**
 * The device's gate: every request a hosted server makes of a lent machine passes here, in this
 * order, and the first check that fails answers it. Who is asking, whether the person is there,
 * a grant this device minted for this thread, what lending to this workspace allows, the request
 * itself, the folder and the path in it, how much the server has asked already, and then the
 * person, in a window the main process owns. What the person allowed is bound to a hash of what
 * the window showed, and what runs or is read is checked against it again just before.
 *
 * Nothing here draws a window or holds a connection: `ask` is the window, and the caller serves
 * `DeviceRpcs` over the dial and hands each request in.
 */

/** What every request says about itself, as `DeviceRequestBy` decodes it. */
export interface RequestBy {
  readonly requestId: string;
  readonly grant: SignedTurnGrant;
  readonly thread: { readonly id: string; readonly title: string };
  readonly actor: { readonly id: string; readonly name: string };
  readonly othersWrote?: boolean;
  readonly folderId: string;
}

export type ExecPayload = RequestBy & {
  readonly cwd?: string;
  readonly command: string;
  readonly timeoutMs?: number;
  readonly reason?: string;
};
export type ListPayload = RequestBy & { readonly path: string; readonly limit: number };
export type ReadPayload = RequestBy & { readonly path: string; readonly maxBytes: number };

/** A lent folder as the gate holds it: where it is, and the label the server knows it by. */
export interface GateFolder extends LentFolder {
  readonly label: string;
}

/** What the ask window is opened with. Everything the person needs, and nothing to answer with. */
export interface AskRequest {
  readonly approval: DeviceApproval;
  /** What the window must hand back with an allow: the hash of what it showed. */
  readonly hash: string;
  readonly folderLabel: string;
  /** The command as it must be drawn; for a read or listing, the path. */
  readonly display: CommandDisplay;
  /** The server's word, shown as such. */
  readonly thread: { readonly id: string; readonly title: string };
  readonly actorName: string;
  readonly reason?: string;
  readonly othersWrote: boolean;
  /** When the person wrote to the thread from this machine: the grant, which the device vouches for. */
  readonly grantIssuedAt: number;
  /** For a read: the file's size. */
  readonly size?: number;
}

export type AskAnswer =
  | { readonly allowed: true; readonly hash: string }
  | { readonly allowed: false };

export interface DeviceGateOptions {
  /** The hosted server's origin and the workspace this connection lends to. */
  readonly origin: string;
  readonly workspace: string;
  /** The signed-in person's subject id. A request acting for anyone else is refused. */
  readonly personId: string;
  /** The folders lent to this workspace now, by id. */
  readonly folders: () => ReadonlyMap<string, GateFolder>;
  /** What the workspace's policy allows now: `exec` is left out when it is read only. */
  readonly capabilities: () => ReadonlyArray<DeviceCapability>;
  /** The person is at the machine, unlocked, and lending is on. */
  readonly present: () => boolean;
  readonly grants: GrantLedger;
  /** The limits for this server, shared by every workspace on it. */
  readonly limits: AskLimits;
  /**
   * Shows the ask in a window the main process owns and answers with what the person chose.
   * `withdrawn` aborts when the server takes the request back, it times out or lending stops:
   * the window then shows it as withdrawn, and the answer is ignored.
   */
  readonly ask: (request: AskRequest, withdrawn: AbortSignal) => Promise<AskAnswer>;
  /** The environment a command gets, already filtered, and the values to redact. */
  readonly environment: () => {
    readonly env: Readonly<Record<string, string>>;
    readonly secrets: ReadonlyArray<string>;
  };
  readonly log: (entry: DeviceLogEntry) => Promise<unknown>;
  readonly now: () => number;
  readonly askWaitMs?: number;
  readonly run?: typeof runCommand;
}

/** How many finished requests are remembered, so a repeat answers with how one ended. */
export const REQUESTS_REMEMBERED = 256;

type Refusal = { readonly kind: "refused"; readonly why: DeviceRefusalReason };
const refusal = (why: DeviceRefusalReason): Refusal => ({ kind: "refused", why });

/** The same payload, whatever order its keys came in. */
const fingerprint = (kind: string, payload: unknown): string =>
  JSON.stringify([kind, payload], (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : value,
  );

interface Running {
  readonly fingerprint: string;
  /** Takes the request back: withdraws its ask, or stops its command. */
  readonly controller: AbortController;
  /** For a command: every event so far, and who else is listening. */
  readonly events: Array<DeviceExecEvent>;
  readonly listeners: Set<(event: DeviceExecEvent) => void>;
  /** The answer, or for a command the work under way. */
  answer: Promise<unknown>;
  done: boolean;
}

export interface DeviceGate {
  readonly exec: (payload: ExecPayload, emit: (event: DeviceExecEvent) => void) => Promise<void>;
  readonly list: (payload: ListPayload) => Promise<DeviceListResult>;
  readonly read: (payload: ReadPayload) => Promise<DeviceReadResult>;
  /** Takes a request back. An id the gate doesn't know is already over. */
  readonly cancel: (requestId: string) => void;
  /**
   * Ends everything under way: asks are withdrawn and refused with `why`, commands stopped. For
   * a lock, the person stepping away, lending stopping, a pause or a quit.
   */
  readonly stopAll: (why: "away" | "paused") => void;
}

const askFields = (payload: RequestBy & { readonly reason?: string }) => ({
  thread: { id: payload.thread.id, title: payload.thread.title },
  actorName: payload.actor.name,
  ...(payload.reason === undefined ? {} : { reason: payload.reason }),
  othersWrote: payload.othersWrote === true,
  grantIssuedAt: payload.grant.grant.issuedAt,
});

export const makeDeviceGate = (options: DeviceGateOptions): DeviceGate => {
  const requests = new Map<string, Running>();
  const run = options.run ?? runCommand;
  const askWaitMs = options.askWaitMs ?? DEVICE_ASK_WAIT_MS;
  /** Why everything was stopped, for the requests that were under way. */
  const stoppedWith = new WeakMap<AbortSignal, "away" | "paused">();

  const forget = () => {
    for (const [id, request] of requests) {
      if (requests.size <= REQUESTS_REMEMBERED) break;
      if (request.done) requests.delete(id);
    }
  };

  const record = (
    payload: RequestBy,
    kind: DeviceLogEntry["kind"],
    folder: string,
    what: string,
    answer: DeviceLogEntry["answer"],
    result?: CommandResult,
  ) =>
    options
      .log({
        time: options.now(),
        origin: options.origin,
        workspace: options.workspace,
        thread: payload.thread.id,
        threadTitle: payload.thread.title,
        folder,
        kind,
        what,
        answer,
        ...(result?.code === undefined ? {} : { exitCode: result.code }),
        ...(result?.signal === undefined ? {} : { signal: result.signal }),
        ...(result === undefined ? {} : { timedOut: result.timedOut }),
      })
      // The log failing doesn't change the answer, and is the caller's to show.
      .catch(() => undefined);

  /** The checks before any path is looked at. */
  const whoAndWhen = (payload: RequestBy, kind: DeviceLogEntry["kind"]): Refusal | undefined => {
    if (payload.actor.id !== options.personId) return refusal("not-for-this-person");
    if (!options.present()) return refusal("away");
    const thread = {
      origin: options.origin,
      workspace: options.workspace,
      thread: payload.thread.id,
    };
    if (!options.grants.holds(payload.grant, thread)) return refusal("no-grant");
    if (kind === "exec" && !options.capabilities().includes("exec")) return refusal("read-only");
    if (!options.capabilities().includes("read")) return refusal("read-only");
    if (options.limits.paused()) return refusal("paused");
    return undefined;
  };

  /** A path refusal counts against the server's allowance, since each says a little about the disk. */
  const pathRefused = (why: DeviceRefusalReason): Refusal => {
    const counted = options.limits.refusedUnasked();
    return refusal(counted === "ok" ? why : counted);
  };

  /**
   * Shows the ask and waits for the answer: an allow for exactly `hash`, a refusal, nothing in
   * time, or the request taken back. Settles the server's limits once, however it ends.
   */
  const askPerson = async (
    request: AskRequest,
    signal: AbortSignal,
  ): Promise<"allowed" | Refusal | "withdrawn"> => {
    const admitted = options.limits.admit(request.thread.id);
    if (typeof admitted === "string") return refusal(admitted);
    const withdrawn = new AbortController();
    const onAbort = () => withdrawn.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((done) => {
      timer = setTimeout(() => done("late"), askWaitMs);
    });
    const aborted = new Promise<"aborted">((done) => {
      if (withdrawn.signal.aborted) done("aborted");
      withdrawn.signal.addEventListener("abort", () => done("aborted"), { once: true });
    });
    let outcome: AskOutcome;
    let answer: "allowed" | Refusal | "withdrawn";
    try {
      const result = await Promise.race([
        options.ask(request, withdrawn.signal).catch((): AskAnswer => ({ allowed: false })),
        late,
        aborted,
      ]);
      if (result === "late") {
        outcome = "unanswered";
        answer = refusal("not-answered");
      } else if (result === "aborted" || signal.aborted) {
        const why = stoppedWith.get(signal);
        outcome = why === undefined ? "withdrawn" : "stopped";
        answer = why === undefined ? "withdrawn" : refusal(why);
      } else if (
        result.allowed &&
        typeof result.hash === "string" &&
        sameHash(result.hash, request.hash)
      ) {
        outcome = "allowed";
        answer = "allowed";
      } else {
        outcome = "refused";
        answer = refusal("not-allowed-by-person");
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // The window learns its ask is over, however it ended.
      withdrawn.abort();
    }
    admitted.settle(outcome);
    return answer;
  };

  const approvalFor = (
    payload: RequestBy,
    kind: DeviceApproval["kind"],
    folder: GateFolder,
    target: string,
    command: string,
    timeoutMs: number,
  ): { approval: DeviceApproval; hash: string } => {
    const approval: DeviceApproval = {
      origin: options.origin,
      workspace: options.workspace,
      requestId: payload.requestId,
      kind,
      folder: folder.path,
      target,
      command,
      timeoutMs,
    };
    return { approval, hash: approvalHash(approval) };
  };

  /**
   * Takes a request once per id: a repeat with the same payload gets the first one's answer, a
   * repeat with another payload is refused.
   */
  const once = <A>(
    kind: string,
    payload: RequestBy,
    start: (signal: AbortSignal) => Promise<A>,
    changed: () => A,
  ): Promise<A> => {
    const print = fingerprint(kind, payload);
    const seen = requests.get(payload.requestId);
    if (seen !== undefined)
      return seen.fingerprint === print ? (seen.answer as Promise<A>) : Promise.resolve(changed());
    const controller = new AbortController();
    const entry: Running = {
      fingerprint: print,
      controller,
      events: [],
      listeners: new Set(),
      answer: Promise.resolve(),
      done: false,
    };
    requests.set(payload.requestId, entry);
    const answer = start(controller.signal).finally(() => {
      entry.done = true;
      forget();
    });
    entry.answer = answer;
    return answer;
  };

  const list = (payload: ListPayload): Promise<DeviceListResult> =>
    once(
      "list",
      payload,
      async (signal) => {
        const early = whoAndWhen(payload, "list");
        const folder = options.folders().get(payload.folderId);
        if (early !== undefined) {
          void record(payload, "list", folder?.path ?? "", payload.path, early.why);
          return early;
        }
        if (folder === undefined) {
          const refused = pathRefused("outside-folders");
          void record(payload, "list", "", payload.path, refused.why);
          return refused;
        }
        const target = await resolveLentFolder(folder, payload.path);
        if (!target.ok) {
          const refused = pathRefused(target.why);
          void record(payload, "list", folder.path, payload.path, refused.why);
          return refused;
        }
        const { approval, hash } = approvalFor(payload, "list", folder, target.path, "", 0);
        const answer = await askPerson(
          {
            approval,
            hash,
            folderLabel: folder.label,
            display: displayCommand(target.path),
            ...askFields(payload),
          },
          signal,
        );
        if (answer !== "allowed") {
          void record(
            payload,
            "list",
            folder.path,
            target.path,
            answer === "withdrawn" ? "withdrawn" : answer.why,
          );
          return answer === "withdrawn" ? refusal("not-answered") : answer;
        }
        if (!options.present()) return refusal("away");
        const listed = await listLentFolder(folder, payload.path, payload.limit, target.path);
        void record(payload, "list", folder.path, target.path, listed.ok ? "allowed" : listed.why);
        return listed.ok
          ? { kind: "listed", entries: [...listed.entries], truncated: listed.truncated }
          : refusal(listed.why);
      },
      () => refusal("changed-request"),
    );

  const read = (payload: ReadPayload): Promise<DeviceReadResult> =>
    once(
      "read",
      payload,
      async (signal) => {
        const early = whoAndWhen(payload, "read");
        const folder = options.folders().get(payload.folderId);
        if (early !== undefined) {
          void record(payload, "read", folder?.path ?? "", payload.path, early.why);
          return early;
        }
        if (folder === undefined) {
          const refused = pathRefused("outside-folders");
          void record(payload, "read", "", payload.path, refused.why);
          return refused;
        }
        const target = await resolveLentFile(folder, payload.path);
        if (!target.ok) {
          const refused = pathRefused(target.why);
          void record(payload, "read", folder.path, payload.path, refused.why);
          return refused;
        }
        const { approval, hash } = approvalFor(payload, "read", folder, target.path, "", 0);
        const answer = await askPerson(
          {
            approval,
            hash,
            folderLabel: folder.label,
            display: displayCommand(target.path),
            size: target.size,
            ...askFields(payload),
          },
          signal,
        );
        if (answer !== "allowed") {
          void record(
            payload,
            "read",
            folder.path,
            target.path,
            answer === "withdrawn" ? "withdrawn" : answer.why,
          );
          return answer === "withdrawn" ? refusal("not-answered") : answer;
        }
        if (!options.present()) return refusal("away");
        const file = await readLentFile(folder, payload.path, payload.maxBytes, target.path);
        void record(payload, "read", folder.path, target.path, file.ok ? "allowed" : file.why);
        return file.ok
          ? { kind: "read", data: file.data.toString("base64"), truncated: file.truncated }
          : refusal(file.why);
      },
      () => refusal("changed-request"),
    );

  const exec = async (
    payload: ExecPayload,
    emit: (event: DeviceExecEvent) => void,
  ): Promise<void> => {
    const print = fingerprint("exec", payload);
    const seen = requests.get(payload.requestId);
    if (seen !== undefined) {
      if (seen.fingerprint !== print) {
        emit(refusal("changed-request"));
        return;
      }
      // Join: what happened so far, then the rest as it comes.
      for (const event of seen.events) emit(event);
      if (seen.done) return;
      seen.listeners.add(emit);
      await seen.answer;
      seen.listeners.delete(emit);
      return;
    }
    const controller = new AbortController();
    const events: Array<DeviceExecEvent> = [];
    const listeners = new Set<(event: DeviceExecEvent) => void>([emit]);
    const send = (event: DeviceExecEvent) => {
      events.push(event);
      for (const listener of listeners) listener(event);
    };
    const entry: Running = {
      fingerprint: print,
      controller,
      events,
      listeners,
      answer: Promise.resolve(),
      done: false,
    };
    requests.set(payload.requestId, entry);
    const work = execNow(payload, controller.signal, send);
    entry.answer = work;
    try {
      await work;
    } finally {
      entry.done = true;
      listeners.clear();
      forget();
    }
  };

  const execNow = async (
    payload: ExecPayload,
    signal: AbortSignal,
    send: (event: DeviceExecEvent) => void,
  ): Promise<void> => {
    const folder = options.folders().get(payload.folderId);
    const where = folder?.path ?? "";
    const early = whoAndWhen(payload, "exec");
    if (early !== undefined) {
      void record(payload, "exec", where, payload.command, early.why);
      send(early);
      return;
    }
    if (deviceCommandProblem(payload.command) !== undefined) {
      void record(payload, "exec", where, payload.command, "too-large");
      send(refusal("too-large"));
      return;
    }
    if (folder === undefined) {
      const refused = pathRefused("outside-folders");
      void record(payload, "exec", "", payload.command, refused.why);
      send(refused);
      return;
    }
    const cwd = await resolveWorkingFolder(folder, payload.cwd);
    if (!cwd.ok) {
      const refused = pathRefused(cwd.why);
      void record(payload, "exec", folder.path, payload.command, refused.why);
      send(refused);
      return;
    }
    const timeoutMs = deviceTimeout(payload.timeoutMs);
    const { approval, hash } = approvalFor(
      payload,
      "exec",
      folder,
      cwd.path,
      payload.command,
      timeoutMs,
    );
    send({ kind: "asked" });
    const answer = await askPerson(
      {
        approval,
        hash,
        folderLabel: folder.label,
        display: displayCommand(payload.command),
        ...askFields(payload),
      },
      signal,
    );
    if (answer !== "allowed") {
      void record(
        payload,
        "exec",
        folder.path,
        payload.command,
        answer === "withdrawn" ? "withdrawn" : answer.why,
      );
      // A request the server took back ends without an answer: it asked for that.
      if (answer !== "withdrawn") send(answer);
      return;
    }
    // Just before it runs: still there, and the folder it was allowed in is still where it was.
    if (!options.present()) {
      send(refusal("away"));
      return;
    }
    const again = await resolveWorkingFolder(folder, payload.cwd);
    if (!again.ok || again.path !== cwd.path) {
      void record(payload, "exec", folder.path, payload.command, "outside-folders");
      send(refusal("outside-folders"));
      return;
    }
    if (signal.aborted) return;
    const { env, secrets } = options.environment();
    send({ kind: "started" });
    let result: CommandResult;
    try {
      result = await run({
        command: payload.command,
        cwd: again.path,
        env,
        secrets,
        timeoutMs,
        signal,
      });
    } catch {
      // It didn't start: the folder went, or the shell couldn't be started. No code, no signal.
      void record(payload, "exec", folder.path, payload.command, "allowed");
      send({ kind: "exit", truncated: false, timedOut: false });
      return;
    }
    void record(payload, "exec", folder.path, payload.command, "allowed", result);
    for (const output of result.output) send({ kind: "output", ...output });
    send({
      kind: "exit",
      ...(result.code === undefined ? {} : { code: result.code }),
      ...(result.signal === undefined ? {} : { signal: result.signal }),
      truncated: result.truncated,
      timedOut: result.timedOut,
    });
  };

  return {
    exec,
    list,
    read,
    cancel: (requestId) => {
      requests.get(requestId)?.controller.abort();
    },
    stopAll: (why) => {
      for (const request of requests.values()) {
        if (request.done) continue;
        stoppedWith.set(request.controller.signal, why);
        request.controller.abort();
      }
    },
  };
};
