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
import type { Admitted, AskLimits, AskOutcome } from "./limits.ts";
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
  /** A clock that only goes forward, for how often refusals are logged. */
  readonly elapsed?: () => number;
}

/** How many finished requests are remembered, so a repeat answers with how one ended. */
export const REQUESTS_REMEMBERED = 256;

/**
 * Requests refused before any ask is shown cost the server nothing in the person's attention, so
 * it could make the device write lines for ever. At most this many are logged in a window; the
 * rest are counted, and one line says how many weren't logged.
 */
export const UNASKED_LOGGED_PER_WINDOW = 20;
export const UNASKED_LOG_WINDOW_MS = 10 * 60_000;
/** How much of the server's command or path a line refused before any ask keeps. */
export const UNASKED_WHAT_MOST = 512;

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
  /** Calls waiting on it. When the last one stops listening, the request is taken back. */
  callers: number;
}

export interface DeviceGate {
  /**
   * Each call may pass `left`, which aborts when that caller stops listening. A request several
   * calls joined is taken back only when the last of them has left.
   */
  readonly exec: (
    payload: ExecPayload,
    emit: (event: DeviceExecEvent) => void,
    left?: AbortSignal,
  ) => Promise<void>;
  readonly list: (payload: ListPayload, left?: AbortSignal) => Promise<DeviceListResult>;
  readonly read: (payload: ReadPayload, left?: AbortSignal) => Promise<DeviceReadResult>;
  /** Takes a request back. An id the gate doesn't know is already over. */
  readonly cancel: (requestId: string) => void;
  /**
   * Ends everything under way: asks are withdrawn and refused with `why`, commands stopped. For
   * a lock, the person stepping away, lending stopping, a pause or a quit.
   */
  readonly stopAll: (why: "away" | "paused") => void;
  /** Settles when every request under way has its answer. */
  readonly idle: () => Promise<void>;
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
  const elapsed = options.elapsed ?? (() => performance.now());
  let unaskedLogged: Array<number> = [];
  let unaskedDropped = 0;

  /** How a request that was taken back or stopped is answered. */
  const takenBack = (signal: AbortSignal): Refusal | "withdrawn" => {
    const why = stoppedWith.get(signal);
    return why === undefined ? "withdrawn" : refusal(why);
  };

  /** Counts a caller in, and takes the request back when the last one leaves. */
  const join = (entry: Running, left: AbortSignal | undefined) => {
    entry.callers += 1;
    if (left === undefined) return;
    const leave = () => {
      entry.callers -= 1;
      if (entry.callers <= 0 && !entry.done) entry.controller.abort();
    };
    if (left.aborted) leave();
    else left.addEventListener("abort", leave, { once: true });
  };

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

  /** A refusal before any ask: logged within a budget, with the server's words cut short. */
  const recordUnasked = (
    payload: RequestBy,
    kind: DeviceLogEntry["kind"],
    folder: string,
    what: string,
    answer: DeviceRefusalReason,
  ) => {
    const from = elapsed() - UNASKED_LOG_WINDOW_MS;
    unaskedLogged = unaskedLogged.filter((time) => time > from);
    if (unaskedLogged.length >= UNASKED_LOGGED_PER_WINDOW) {
      unaskedDropped += 1;
      return;
    }
    unaskedLogged.push(elapsed());
    if (unaskedDropped > 0) {
      const dropped = unaskedDropped;
      unaskedDropped = 0;
      void record(
        payload,
        kind,
        "",
        `${dropped} more requests refused before any ask were not logged.`,
        answer,
      );
    }
    void record(
      payload,
      kind,
      folder,
      what.length > UNASKED_WHAT_MOST ? `${what.slice(0, UNASKED_WHAT_MOST)}…` : what,
      answer,
    );
  };

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

  /**
   * Takes a place among the asks waiting before any path is looked at, so the answer to a path
   * never depends on whether there was room: a path refused frees it again, still counted.
   */
  const admit = (payload: RequestBy): Admitted | Refusal => {
    const admitted = options.limits.admit(payload.thread.id);
    return typeof admitted === "string" ? refusal(admitted) : admitted;
  };

  /** Everything checked before the ask, again, after the allow: any of it may have changed. */
  const stillAllowed = (
    payload: RequestBy,
    kind: DeviceLogEntry["kind"],
    folder: GateFolder,
    signal: AbortSignal,
  ): Refusal | "withdrawn" | undefined => {
    if (signal.aborted) return takenBack(signal);
    const early = whoAndWhen(payload, kind);
    if (early !== undefined) return early;
    const now = options.folders().get(payload.folderId);
    if (
      now === undefined ||
      now.path !== folder.path ||
      now.device !== folder.device ||
      now.inode !== folder.inode
    )
      return refusal("outside-folders");
    return undefined;
  };

  /**
   * Shows the ask and waits for the answer: an allow for exactly `hash`, a refusal, nothing in
   * time, or the request taken back. Settles the server's limits once, however it ends.
   */
  const askPerson = async (
    request: AskRequest,
    admitted: Admitted,
    signal: AbortSignal,
  ): Promise<"allowed" | Refusal | "withdrawn"> => {
    // Taken back or stopped while the path was being looked at: no window, and nothing counted
    // against the person.
    if (signal.aborted) {
      admitted.settle(stoppedWith.has(signal) ? "stopped" : "withdrawn");
      return takenBack(signal);
    }
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
    let outcome: AskOutcome = "refused";
    let answer: "allowed" | Refusal | "withdrawn" = refusal("not-allowed-by-person");
    try {
      const result = await Promise.race([
        // A window that throws, even before it returns a promise, is a refusal.
        Promise.resolve()
          .then(() => options.ask(request, withdrawn.signal))
          .catch((): AskAnswer => ({ allowed: false })),
        late,
        aborted,
      ]);
      if (result === "late") {
        outcome = "unanswered";
        answer = refusal("not-answered");
      } else if (result === "aborted" || signal.aborted) {
        outcome = stoppedWith.has(signal) ? "stopped" : "withdrawn";
        answer = takenBack(signal);
      } else if (
        result.allowed &&
        typeof result.hash === "string" &&
        sameHash(result.hash, request.hash)
      ) {
        outcome = "allowed";
        answer = "allowed";
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // The window learns its ask is over, however it ended.
      withdrawn.abort();
      admitted.settle(outcome);
    }
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
    left: AbortSignal | undefined,
    start: (signal: AbortSignal) => Promise<A>,
    changed: () => A,
  ): Promise<A> => {
    const print = fingerprint(kind, payload);
    const seen = requests.get(payload.requestId);
    if (seen !== undefined) {
      if (seen.fingerprint !== print) return Promise.resolve(changed());
      if (!seen.done) join(seen, left);
      return seen.answer as Promise<A>;
    }
    const controller = new AbortController();
    const entry: Running = {
      fingerprint: print,
      controller,
      events: [],
      listeners: new Set(),
      answer: Promise.resolve(),
      done: false,
      callers: 0,
    };
    requests.set(payload.requestId, entry);
    join(entry, left);
    const answer = start(controller.signal).finally(() => {
      entry.done = true;
      forget();
    });
    entry.answer = answer;
    return answer;
  };

  /** What a list or read does after the allow, with the real path the person was shown. */
  const filesRequest = <A extends { readonly kind: string }>(
    kind: "list" | "read",
    payload: RequestBy & { readonly path: string },
    signal: AbortSignal,
    resolve: (
      folder: GateFolder,
    ) => Promise<
      | { readonly ok: true; readonly path: string; readonly size?: number }
      | { readonly ok: false; readonly why: DeviceRefusalReason }
    >,
    fetch: (
      folder: GateFolder,
      target: { readonly path: string; readonly size?: number },
    ) => Promise<A | Refusal>,
  ): Promise<A | Refusal> =>
    (async () => {
      const early = whoAndWhen(payload, kind);
      const lent = options.folders().get(payload.folderId);
      if (early !== undefined) {
        recordUnasked(payload, kind, lent?.path ?? "", payload.path, early.why);
        return early;
      }
      const admitted = admit(payload);
      if (!("settle" in admitted)) {
        recordUnasked(payload, kind, lent?.path ?? "", payload.path, admitted.why);
        return admitted;
      }
      if (lent === undefined) {
        admitted.settle("unasked");
        recordUnasked(payload, kind, "", payload.path, "outside-folders");
        return refusal("outside-folders");
      }
      const folder = lent;
      const target = await resolve(folder);
      if (!target.ok) {
        admitted.settle("unasked");
        recordUnasked(payload, kind, folder.path, payload.path, target.why);
        return refusal(target.why);
      }
      const { approval, hash } = approvalFor(payload, kind, folder, target.path, "", 0);
      const answer = await askPerson(
        {
          approval,
          hash,
          folderLabel: folder.label,
          display: displayCommand(target.path),
          ...(target.size === undefined ? {} : { size: target.size }),
          ...askFields(payload),
        },
        admitted,
        signal,
      );
      const after = answer === "allowed" ? stillAllowed(payload, kind, folder, signal) : answer;
      if (after !== undefined) {
        void record(
          payload,
          kind,
          folder.path,
          target.path,
          after === "withdrawn" ? "withdrawn" : after.why,
        );
        return after === "withdrawn" ? refusal("not-answered") : after;
      }
      const fetched = await fetch(folder, target);
      void record(
        payload,
        kind,
        folder.path,
        target.path,
        fetched.kind === "refused" ? (fetched as Refusal).why : "allowed",
      );
      return fetched;
    })();

  const list = (payload: ListPayload, left?: AbortSignal): Promise<DeviceListResult> =>
    once(
      "list",
      payload,
      left,
      (signal) =>
        filesRequest(
          "list",
          payload,
          signal,
          (folder) => resolveLentFolder(folder, payload.path),
          async (folder, target): Promise<DeviceListResult> => {
            const listed = await listLentFolder(folder, payload.path, payload.limit, target.path);
            return listed.ok
              ? { kind: "listed", entries: [...listed.entries], truncated: listed.truncated }
              : refusal(listed.why);
          },
        ),
      () => refusal("changed-request"),
    );

  const read = (payload: ReadPayload, left?: AbortSignal): Promise<DeviceReadResult> =>
    once(
      "read",
      payload,
      left,
      (signal) =>
        filesRequest(
          "read",
          payload,
          signal,
          (folder) => resolveLentFile(folder, payload.path),
          async (folder, target): Promise<DeviceReadResult> => {
            // No more than the size the person was shown, even if the file grew since.
            const most = Math.min(payload.maxBytes, target.size ?? payload.maxBytes);
            // Shown empty, it is read as empty: nothing is opened that the window didn't show.
            if (most === 0) return { kind: "read", data: "", truncated: target.size === 0 };
            const file = await readLentFile(folder, payload.path, most, target.path);
            return file.ok
              ? {
                  kind: "read",
                  data: file.data.toString("base64"),
                  truncated: file.truncated,
                }
              : refusal(file.why);
          },
        ),
      () => refusal("changed-request"),
    );

  const exec = async (
    payload: ExecPayload,
    emit: (event: DeviceExecEvent) => void,
    left?: AbortSignal,
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
      join(seen, left);
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
      callers: 0,
    };
    requests.set(payload.requestId, entry);
    join(entry, left);
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
    const lent = options.folders().get(payload.folderId);
    const where = lent?.path ?? "";
    const early = whoAndWhen(payload, "exec");
    if (early !== undefined) {
      recordUnasked(payload, "exec", where, payload.command, early.why);
      send(early);
      return;
    }
    if (deviceCommandProblem(payload.command) !== undefined) {
      recordUnasked(payload, "exec", where, payload.command, "too-large");
      send(refusal("too-large"));
      return;
    }
    const admitted = admit(payload);
    if (!("settle" in admitted)) {
      recordUnasked(payload, "exec", where, payload.command, admitted.why);
      send(admitted);
      return;
    }
    if (lent === undefined) {
      admitted.settle("unasked");
      recordUnasked(payload, "exec", "", payload.command, "outside-folders");
      send(refusal("outside-folders"));
      return;
    }
    const folder = lent;
    const cwd = await resolveWorkingFolder(folder, payload.cwd);
    if (!cwd.ok) {
      admitted.settle("unasked");
      recordUnasked(payload, "exec", folder.path, payload.command, cwd.why);
      send(refusal(cwd.why));
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
    // Taken back while the folder was looked at, it is never asked.
    if (!signal.aborted) {
      try {
        send({ kind: "asked" });
      } catch (error) {
        admitted.settle("unasked");
        throw error;
      }
    }
    const answer = await askPerson(
      {
        approval,
        hash,
        folderLabel: folder.label,
        display: displayCommand(payload.command),
        ...askFields(payload),
      },
      admitted,
      signal,
    );
    // Just before it runs: everything checked before the ask still holds, and the folder it was
    // allowed in is still where it was.
    // Checked after the last wait, so nothing can change between the check and the run.
    let after: Refusal | "withdrawn" | undefined = answer === "allowed" ? undefined : answer;
    let again: Awaited<ReturnType<typeof resolveWorkingFolder>> | undefined;
    if (after === undefined) {
      again = await resolveWorkingFolder(folder, payload.cwd);
      after = stillAllowed(payload, "exec", folder, signal);
      if (after === undefined && (!again.ok || again.path !== cwd.path))
        after = refusal("outside-folders");
    }
    if (after !== undefined || again === undefined || !again.ok) {
      const why = after ?? refusal("outside-folders");
      void record(
        payload,
        "exec",
        folder.path,
        payload.command,
        why === "withdrawn" ? "withdrawn" : why.why,
      );
      // A request the server took back ends without an answer: it asked for that.
      if (why !== "withdrawn") send(why);
      return;
    }
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
    idle: async () => {
      await Promise.allSettled(
        [...requests.values()].filter((request) => !request.done).map((request) => request.answer),
      );
    },
    stopAll: (why) => {
      for (const request of requests.values()) {
        if (request.done) continue;
        // The first reason stands: a pause followed by the hang-up it causes is still a pause.
        if (!stoppedWith.has(request.controller.signal))
          stoppedWith.set(request.controller.signal, why);
        request.controller.abort();
      }
    },
  };
};
