// Stopping a joined machine with its disk kept, and resuming its threads on a host started on that
// disk later: the hosted features' way of paying for a machine only while it works. Whoever runs
// the machines asks here before stopping one (`prepareStop`), stops it, and starts a host on its
// disk again when it is wanted (`stopStatus` says when); that host dials in as the same machine,
// since its key is on the disk, and `resumeHost` opens the threads' sessions on it again.
//
// Nothing here stops or starts a machine: that is the caller's to do.

import {
  type Checkout,
  effectiveCheckout,
  HostFailed,
  type HostBusy,
  type HostId,
  hostOf,
  type HostStopKept,
  type HostUnavailable,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import { wipRef } from "@gram/git";
import * as Effect from "effect/Effect";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import type { RemoteHostsShape } from "./remote-hosts.ts";

export interface StopResumeDeps {
  readonly hosts: Pick<RemoteHostsShape, "connection" | "machines" | "stops">;
  readonly store: Pick<ThreadStore["Service"], "listThreads">;
  readonly runtimes: Pick<ThreadRuntimesShape, "restSession" | "startSession">;
}

/** Every checkout a thread holds, followed ones included. */
const checkoutsOf = (thread: Thread): ReadonlyArray<Checkout> => [
  thread.checkout,
  ...(thread.currentCheckout === undefined ? [] : [thread.currentCheckout]),
  ...(thread.extraCheckouts ?? []),
];

/**
 * The threads with a folder on the machine, each with its folders there, and whether its session
 * runs there (`placed.ts` opens a thread's session on its effective checkout's machine; an
 * archived thread has none).
 */
const placedOn = (threads: ReadonlyArray<Thread>, id: HostId) =>
  threads.flatMap((thread) => {
    const cwds = [
      ...new Set(
        checkoutsOf(thread)
          .filter((checkout) => hostOf(checkout) === id)
          .map((checkout) => checkout.path),
      ),
    ];
    return cwds.length === 0
      ? []
      : [
          {
            thread,
            cwds,
            session: !thread.parked && hostOf(effectiveCheckout(thread)) === id,
          },
        ];
  });

/** The most folders one stop is asked to keep (`host.stop.prepare`'s limit). */
export const STOP_FOLDERS_MAX = 512;
/** How long a machine gets to say it takes work again. */
const CANCEL_WITHIN = "30 seconds";

/** What a stop kept of one folder, as this Gram vouches for it. */
export interface KeptWork {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly ref?: string;
  readonly commit?: string;
  readonly pushed: boolean;
  readonly note?: string;
}

export interface StopPrepared {
  /** Whether the machine can be stopped now with nothing cut off. */
  readonly idle: boolean;
  readonly busy: HostBusy;
  readonly kept: ReadonlyArray<KeptWork>;
  readonly note?: string;
  /** The threads at work on it that a stop now would cut off, and that go on once it is back. */
  readonly working: ReadonlyArray<ThreadId>;
}

/**
 * What the host said it kept, held to what was asked: only folders this Gram named, under the ref
 * this Gram would have written, with a commit that reads as one. A host's word is otherwise its
 * own: `pushed` is its claim.
 */
const keptOf = (
  asked: ReadonlyArray<{ readonly threadId: ThreadId; readonly cwd: string }>,
  said: ReadonlyArray<HostStopKept>,
): ReadonlyArray<KeptWork> =>
  asked.map(({ threadId, cwd }) => {
    const answer = said.find((kept) => kept.threadId === threadId && kept.cwd === cwd);
    if (answer === undefined)
      return { threadId, cwd, pushed: false, note: "The machine didn't say." };
    const sound =
      answer.ref === wipRef(threadId) &&
      answer.commit !== undefined &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(answer.commit);
    return {
      threadId,
      cwd,
      ...(sound ? { ref: answer.ref, commit: answer.commit } : {}),
      pushed: sound && answer.pushed,
      ...(answer.note === undefined ? {} : { note: answer.note }),
    };
  });

/**
 * Readies the machine to stop (`host.stop.prepare`), with every folder its threads hold there to
 * keep. When it says it is idle, the threads' sessions there are put to rest, so each opens again
 * on its conversation with its next message. Forced, whatever runs there is cut off by the stop:
 * those threads wait for the machine and go on once a host on its disk dials in.
 */
export const prepareStop = (
  deps: StopResumeDeps,
  id: HostId,
  options: { readonly force?: boolean | undefined; readonly remote?: string | undefined } = {},
): Effect.Effect<StopPrepared, HostFailed | HostUnavailable> =>
  Effect.gen(function* () {
    const connection = yield* deps.hosts.connection(id);
    const placed = placedOn(yield* deps.store.listThreads, id);
    // Threads whose sessions run there first and archived ones last, should there be more folders
    // than one stop keeps.
    const rank = (entry: (typeof placed)[number]) =>
      entry.session ? 0 : entry.thread.parked ? 2 : 1;
    const folders = placed
      .toSorted((a, b) => rank(a) - rank(b))
      .flatMap(({ thread, cwds }) => cwds.map((cwd) => ({ threadId: thread.id, cwd })));
    const asked = folders.slice(0, STOP_FOLDERS_MAX);
    const cancels = deps.hosts.stops.cancels(id);
    // The machine takes work again, and no longer counts as readied here either.
    const takeBack = connection.stop.cancel.pipe(
      Effect.timeout(CANCEL_WITHIN),
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => deps.hosts.stops.back(id))),
    );
    const prepared = yield* connection.stop
      .prepare({
        checkouts: asked,
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.remote === undefined ? {} : { remote: options.remote }),
      })
      .pipe(
        // An ask that got no answer, or whose asker went away, leaves no machine holding.
        Effect.tapError((error) => (error._tag === "HostFailed" ? takeBack : Effect.void)),
        Effect.onInterrupt(() => takeBack),
      );
    const kept = keptOf(asked, prepared.kept);
    const left = folders.length - asked.length;
    const note =
      prepared.note ??
      (left > 0 ? `${left} more folders than one stop keeps were left as they are.` : undefined);
    const answer = { busy: prepared.busy, kept, ...(note === undefined ? {} : { note }) };
    // Not idle and not forced, or a stop that didn't hold: the machine takes work as before.
    if (prepared.released === true || (!prepared.idle && options.force !== true)) {
      // An earlier stop that this one's release ended isn't holding any more.
      if (prepared.released === true) deps.hosts.stops.back(id);
      return { ...answer, kept: prepared.kept.length === 0 ? [] : kept, idle: false, working: [] };
    }
    const rested: Array<ThreadId> = [];
    const working: Array<ThreadId> = [];
    for (const { thread, session } of placed) {
      if (!session) continue;
      const state = yield* deps.runtimes.restSession(thread.id);
      if (state === "rested") rested.push(thread.id);
      else if (state === "working") working.push(thread.id);
    }
    // A thread that took work between the machine's look and this one: the stop isn't safe.
    if (working.length > 0 && options.force !== true) {
      yield* takeBack;
      return {
        ...answer,
        idle: false,
        working,
        note: "A thread on it is at work or has something waiting to go.",
      };
    }
    // Taken back while its sessions were put to rest: the machine takes work again.
    if (deps.hosts.stops.cancels(id) !== cancels) {
      // Said again: the cancel may have reached the machine before this stop did.
      yield* takeBack;
      return { ...answer, idle: false, working, note: "The stop was taken back meanwhile." };
    }
    deps.hosts.stops.stopped(id, rested);
    yield* Effect.logInfo("a machine was readied to stop").pipe(
      Effect.annotateLogs({ hostId: id, idle: prepared.idle, rested: rested.length }),
    );
    return { ...answer, idle: prepared.idle && working.length === 0, working };
  });

/** Takes a stop back: the machine takes work again and no longer counts as stopped. */
export const cancelStop = (
  deps: Pick<StopResumeDeps, "hosts">,
  id: HostId,
): Effect.Effect<void, HostFailed | HostUnavailable> =>
  Effect.gen(function* () {
    const connection = yield* deps.hosts.connection(id);
    // Counted first, so a stop being readied now sees it.
    deps.hosts.stops.cancel(id);
    yield* connection.stop.cancel.pipe(
      Effect.timeoutOrElse({
        duration: CANCEL_WITHIN,
        orElse: () => Effect.fail(new HostFailed({ message: "The machine didn't answer." })),
      }),
    );
  });

export interface HostResumed {
  /** The threads whose sessions were opened on the machine again. */
  readonly reopened: ReadonlyArray<ThreadId>;
  /** Those left to open with their next message, and why. */
  readonly left: ReadonlyArray<{ readonly threadId: ThreadId; readonly reason: string }>;
  /** Threads with a folder there whose folder the machine doesn't have: its disk isn't the one. */
  readonly missing: ReadonlyArray<{ readonly threadId: ThreadId; readonly cwd: string }>;
}

/**
 * Resumes the machine's threads on the host that dialled in as it: checks each thread's folders
 * are on its disk, and opens again the sessions the stop put to rest, each on its own
 * conversation. A turn a forced stop cut off needs nothing from here: it goes on by itself once
 * the host is back (`machine-restart.ts`). Fails while the machine is away.
 */
export const resumeHost = (
  deps: StopResumeDeps,
  id: HostId,
): Effect.Effect<HostResumed, HostUnavailable> =>
  Effect.gen(function* () {
    const connection = yield* deps.hosts.connection(id);
    const placed = placedOn(yield* deps.store.listThreads, id);
    const missing: Array<{ readonly threadId: ThreadId; readonly cwd: string }> = [];
    for (const { thread, cwds } of placed)
      for (const cwd of cwds)
        if (!(yield* connection.git.present(cwd))) missing.push({ threadId: thread.id, cwd });
    const gone = new Set(missing.map((entry) => entry.threadId));
    const live = new Set(placed.filter(({ session }) => session).map(({ thread }) => thread.id));
    const reopened: Array<ThreadId> = [];
    const left: Array<{ readonly threadId: ThreadId; readonly reason: string }> = [];
    for (const threadId of deps.hosts.stops.takeRested(id)) {
      // Archived, closed or moved since the stop.
      if (!live.has(threadId)) continue;
      if (gone.has(threadId)) {
        left.push({ threadId, reason: "Its folder isn't on the machine." });
        continue;
      }
      const started = yield* deps.runtimes.startSession(threadId).pipe(
        Effect.as(undefined),
        Effect.catch((error) =>
          Effect.succeed(error._tag === "InvalidState" ? error.message : "The thread is gone."),
        ),
      );
      if (started === undefined) reopened.push(threadId);
      else left.push({ threadId, reason: started });
    }
    yield* Effect.logInfo("a machine's threads were resumed").pipe(
      Effect.annotateLogs({ hostId: id, reopened: reopened.length, missing: missing.length }),
    );
    return { reopened, left, missing };
  });

export interface StopState {
  readonly id: HostId;
  readonly name: string;
  readonly online: boolean;
  /** When it was readied to stop, epoch ms; absent once it dialled in again. */
  readonly stoppedAt?: number;
  /** A thread waits for it to be started now. */
  readonly wanted: boolean;
}

/** Each joined machine: whether it is dialled in, readied to stop, and wanted. */
export const stopStatus = (
  deps: Pick<StopResumeDeps, "hosts">,
): Effect.Effect<ReadonlyArray<StopState>> =>
  Effect.forEach(
    deps.hosts.machines.list().filter((machine) => machine.confirmedAt !== undefined),
    (machine) =>
      Effect.gen(function* () {
        const id = machine.id as HostId;
        const online = yield* deps.hosts.connection(id).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        const stoppedAt = deps.hosts.stops.stoppedAt(id);
        return {
          id,
          name: machine.name,
          online,
          ...(stoppedAt === undefined ? {} : { stoppedAt }),
          wanted: deps.hosts.stops.wanted(id),
        };
      }),
  );
