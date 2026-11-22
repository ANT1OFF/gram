import { randomUUID } from "node:crypto";

import { HostId, hostServes, type WorkerMachineServer } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Duration from "effect/Duration";
import { ServerConfig } from "../config.ts";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { RemoteHosts, type RemoteHostsShape } from "../host/remote-hosts.ts";
import { noAppToolsTunnel } from "../host/app-tools-tunnel.ts";
import { CHOICES_TTL_MS, type OnDemandChoices, parseChoices } from "./on-demand.ts";
import {
  askWorkerMachine,
  choicesOfAsk,
  type OfferedModel,
  parseOfferedModels,
  type ProvidedMachine,
  type WorkerMachineSource,
  type WorkerMachineStart,
  workerMachineIdentity,
} from "./worker-machines.ts";
import { fencedCalls } from "./signed-in-fences.ts";
import { signInMarks } from "./signed-in-marks.ts";
import {
  claimedHere,
  forgetReclaimed,
  isLegacyRelayed,
  RECLAIMED_EVERY,
} from "./signed-in-reclaim.ts";
import {
  type FinalCheck,
  setAsideNames,
  setAsideStoppedSignedIn,
  takeBackSetAside,
} from "./signed-in-set-aside.ts";
import {
  NO_APP,
  NO_SIGNED_IN_SERVER,
  type RelayedDial,
  WorkerMachinePort,
  type WorkerMachinePortShape,
} from "./signed-in-port.ts";
import {
  isHostedWorkerName,
  parseMachineStatus,
  providerWordOf,
  sendSignedInStart,
  sentOf,
  settledSince,
  type StartsSent,
  tellSignedInRelease,
  wakeSignedIn,
} from "./signed-in-calls.ts";
import {
  codeOf,
  fileOwedStops,
  isNotFound,
  memoryOwedStops,
  OWED_MOST,
  ownsOwing,
  type NameLocks,
  type OwedStops,
  RECLAIMED_AFTER_MISSES,
  settleOwedStops,
  stopHoldUntil,
  stopNotAfter,
  stopOutcome,
  stopSendBy,
  stopSettled,
  UNANSWERED_STOP_HOLD_MS,
  withName,
} from "./worker-machine-stops.ts";
import { plainName } from "./server-name.ts";
import { askOnDrop } from "./signed-in-drops.ts";
import { relaysOf, restingBy, roomFor } from "./signed-in-room.ts";
import { takeRelayedDial } from "./signed-in-dial.ts";

export { plainName } from "./server-name.ts";

export * from "./signed-in-fences.ts";
export * from "./signed-in-port.ts";
export * from "./signed-in-reclaim.ts";
export * from "./signed-in-calls.ts";
export * from "./worker-machine-stops.ts";
export * from "./signed-in-room.ts";
export * from "./signed-in-dial.ts";

const STOP_ATTEMPTS = 3;
const STOP_RETRY_MS = 2_000;
/** How long a wake that met only a passing error waits before it is tried again. */
export const WAKE_RETRY_MS = 5_000;

/** How long a desktop waits for a hosted machine to join before it stops it. */
export const ARRIVE_TIMEOUT_MS = 5 * 60_000;
const ARRIVE_EVERY_MS = 2_000;

const failedWords = (name: string, why: string) => `The machine ${name} didn't join: ${why}`;

export interface SignedInDeps {
  readonly port: WorkerMachinePortShape;
  readonly hosts: Pick<RemoteHostsShape, "remove" | "providerSaid"> & {
    readonly list: () => ReadonlyArray<ProvidedMachine>;
    /** Its host's hello once online, to refuse one that can't carry app tools; absent in fakes. */
    readonly connection?: RemoteHostsShape["connection"];
    readonly machines: Pick<RemoteHostsShape["machines"], "provision"> &
      Partial<Pick<RemoteHostsShape["machines"], "get" | "setAside">>;
  };
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly everyMs?: number;
  readonly stopRetryMs?: number;
  /** How long a name is kept after a stop no one answered (`UNANSWERED_STOP_HOLD_MS`). */
  readonly unansweredHoldMs?: number;
  /** What each server offered, kept across sources a short while; none kept when left out. */
  readonly offered?: OfferedByServer;
  /** Stops a server never confirmed, for machines not registered here, to ask again later. */
  readonly owed?: OwedStops;
  /** The names a start is on its way for, which no stop owed for an earlier one may end. */
  readonly starting?: Set<string>;
  /** One lock per name, shared with the settling of stops owed (`withName`). */
  readonly locks?: NameLocks;
  /** How long a start the server is unavailable for waits before it is asked again, doubled. */
  readonly startRetryMs?: number;
  /**
   * Names the server says are stopped or failed: not relayed, since no dial wakes one there, until
   * a start of the name wakes it (`forgetReclaimed`, `wakeSignedIn`, `SignedInWorkersLive`).
   */
  readonly asleep?: Set<string>;
  /** The starts sent of each name, shared by every source and pass (`StartsSent`). */
  readonly sent?: StartsSent;
  /**
   * The mark a sign-in at `origin` has now, for one it had: a source made before its sign-in took
   * its organisation's mark finds what was moved to it, and asks and owes under it from then on.
   */
  readonly markOf?: (origin: string, account: string) => string | undefined;
}

/**
 * The choices and models each server offered, kept a short while, by origin and the sign-in they
 * were asked under (`workerMachineIdentity`): another sign-in's offer is never another's.
 */
export type OfferedByServer = Map<
  string,
  {
    readonly at: number;
    readonly value?: OnDemandChoices;
    readonly models?: ReadonlyArray<OfferedModel>;
  }
>;

/** A hosted server the app is signed in to, as `sandbox`'s provider. */
export const signedInSource = (
  server: WorkerMachineServer,
  deps: SignedInDeps,
): WorkerMachineSource => {
  const { port, hosts } = deps;
  const now = deps.now ?? Date.now;
  const origin = server.origin;
  const first = server.account;
  const accountNow = () =>
    first === undefined ? undefined : (deps.markOf?.(origin, first) ?? first);
  const markField = (): { account?: string } => {
    const mark = accountNow();
    return mark === undefined ? {} : { account: mark };
  };
  const viaField = (): { viaAccount?: string } => {
    const mark = accountNow();
    return mark === undefined ? {} : { viaAccount: mark };
  };
  const ours = (mark: string | undefined) => mark === first || mark === accountNow();
  const owes = (name: string) =>
    deps.owed
      ?.list()
      .some(
        (each) =>
          ownsOwing(each, origin, name, first) || ownsOwing(each, origin, name, accountNow()),
      ) === true;
  const releaseOwed = (name: string) => {
    deps.owed?.release(origin, name, first);
    if (accountNow() !== first) deps.owed?.release(origin, name, accountNow());
  };
  const offered: OfferedByServer = deps.offered ?? new Map();
  const offeredKey = workerMachineIdentity(origin, first);
  const mine = (machine: ProvidedMachine) =>
    machine.onDemand === "worker" &&
    machine.via === origin &&
    machine.owner === undefined &&
    (machine.viaAccount === undefined || ours(machine.viaAccount));
  const named = (name: string) => hosts.list().find((each) => each.name === name && mine(each));
  const frozen = (name: string) =>
    hosts
      .list()
      .find(
        (each) =>
          each.name === name &&
          each.via === origin &&
          each.onDemand === "worker" &&
          each.owner === undefined &&
          !mine(each),
      );
  const heldFor = (name: string) => {
    const until = deps.owed?.holds.until(origin, name, now());
    return until === undefined ? 0 : until - now();
  };
  const asked = Effect.gen(function* () {
    const kept = offered.get(offeredKey);
    if (kept !== undefined && now() - kept.at < CHOICES_TTL_MS) return kept;
    const answered = yield* port.call(origin, "choices", {}, { account: accountNow() });
    const body = answered.ok && answered.status === 200 ? answered.body : undefined;
    const value = parseChoices(body);
    const models = parseOfferedModels(body);
    const fresh = {
      at: now(),
      ...(value === undefined ? {} : { value }),
      ...(models === undefined ? {} : { models }),
    };
    offered.set(offeredKey, fresh);
    return fresh;
  });
  const forget = (name: string, unsettled = false) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (frozen(name) !== undefined) {
          deps.starting?.delete(name);
          yield* Effect.logWarning(
            "a worker machine was not given back: another sign-in's machine has its name",
          ).pipe(Effect.annotateLogs({ machine: name }));
          return false;
        }
        if (unsettled && deps.owed !== undefined && named(name) === undefined && !owes(name)) {
          deps.starting?.delete(name);
          return true;
        }
        deps.starting?.delete(name);
        let stopped = false;
        let last = "";
        yield* withName(
          deps.locks,
          name,
          Effect.gen(function* () {
            let unanswered = false;
            for (let attempt = 0; attempt < STOP_ATTEMPTS && !stopped; attempt += 1) {
              if (attempt > 0) yield* Effect.sleep(deps.stopRetryMs ?? STOP_RETRY_MS);
              const sentAt = now();
              const held = deps.owed?.holds.hold(origin, name, stopHoldUntil(sentAt));
              if (deps.owed !== undefined && held === undefined) {
                last = "its hold couldn't be written down";
                continue;
              }
              const answered = yield* port.call(
                origin,
                "stop",
                { name, notAfter: stopNotAfter(sentAt) },
                { sendBy: stopSendBy(sentAt), account: accountNow() },
              );
              if (stopSettled(answered) && held !== undefined) deps.owed?.holds.answered(held);
              const outcome = stopOutcome(answered);
              const legacy = isLegacyRelayed(named(name));
              stopped = outcome === "stopped" || (outcome === "absent" && !unsettled && !legacy);
              if (!stopSettled(answered)) unanswered = true;
              last = answered.ok ? `answered ${answered.status}` : "no answer";
            }
            if (unanswered) yield* Effect.sleep(deps.unansweredHoldMs ?? UNANSWERED_STOP_HOLD_MS);
          }),
        );
        if (!stopped) {
          yield* Effect.logWarning("a worker machine given back could not be stopped").pipe(
            Effect.annotateLogs({ machine: name, reason: last }),
          );
          if (named(name) === undefined && !owes(name))
            deps.owed?.add({
              origin,
              name,
              since: now(),
              ...(unsettled ? { unsettled: true as const } : {}),
              ...markField(),
              attempt: randomUUID(),
            });
          return false;
        }
        releaseOwed(name);
        port.unrelay(name);
        const machine = named(name);
        if (machine !== undefined) hosts.remove(HostId.make(machine.id));
        return true;
      }),
    );
  const aside = (id: string) => hosts.machines.get?.(id)?.setAside !== undefined;
  const resting = restingBy(deps.asleep, aside);
  return {
    label: plainName(server.server),
    choices: Effect.map(asked, (kept) => kept.value),
    models: Effect.map(asked, (kept) => kept.models),
    givesBack: true,
    identity: workerMachineIdentity(origin, first),
    unrelease: (name) =>
      Effect.gen(function* () {
        for (let missed = 1; ; missed += 1) {
          const told = yield* tellSignedInRelease(
            port,
            { name, via: origin, account: accountNow() },
            false,
          );
          if (told === "applied") return undefined;
          if (missed >= RECLAIMED_AFTER_MISSES) return "gone" as const;
          yield* Effect.sleep(deps.everyMs ?? ARRIVE_EVERY_MS);
        }
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("a worker machine reused could not be told it is working").pipe(
            Effect.annotateLogs({ machine: name }),
            Effect.as(undefined),
          ),
        ),
      ),
    idOf: (name) => named(name)?.id,
    abandon: (name, options) => Effect.asVoid(forget(name, options?.unsettled === true)),
    start: (ask) =>
      Effect.suspend(() => {
        if (frozen(ask.name) !== undefined)
          return Effect.succeed<WorkerMachineStart>({
            kind: "refused",
            message: `The machine ${ask.name} for this request was asked for under another sign-in to ${server.server} (before you signed in again, say), so it was left as it is: this sign-in neither reuses nor stops it. Spawn again with another clientRequestId for a new machine, or remove the old one under Settings → Machines.`,
          });
        deps.starting?.add(ask.name);
        const owing = {
          origin,
          name: ask.name,
          since: now(),
          unsettled: true as const,
          start: true as const,
          ...markField(),
          attempt: randomUUID(),
        };
        deps.asleep?.delete(ask.name);
        let unavailable = false;
        let owned = false;
        let spent = false;
        if (!isHostedWorkerName(ask.name))
          return Effect.succeed<WorkerMachineStart>({
            kind: "refused",
            message: `${ask.name} isn't a machine name ${server.server} takes, so nothing was asked for.`,
          });
        return askWorkerMachine(
          ask,
          sendSignedInStart(
            port,
            origin,
            ask.name,
            {
              name: ask.name,
              title: ask.title.slice(0, 120),
              orchestrator: ask.orchestrator,
              choices: choicesOfAsk(ask),
            },
            {
              ...deps,
              heldFor,
              account: accountNow(),
              onLocked: () => {
                if (deps.owed === undefined) return undefined;
                owned = deps.owed.admit(owing);
                if (!owned)
                  return {
                    ok: true as const,
                    status: 409,
                    body: {
                      code: "owed_full",
                      message:
                        deps.owed.list().length >= OWED_MOST
                          ? `This Gram is still owed stops for ${deps.owed.list().length} machines that ${server.server} never confirmed stopping, so it starts no more until it is: try again later, or leave out sandbox to run the worker on your machine.`
                          : "This Gram couldn't write down the machine before asking for it (its disk may be full or read-only), so it wasn't asked for: free some space and spawn again, or leave out sandbox to run the worker on your machine.",
                    },
                  };
                return undefined;
              },
            },
          ).pipe(
            Effect.map((sent) => {
              unavailable = sent.unavailable;
              const answered = sent.answered;
              spent =
                answered.ok && answered.status === 409 && codeOf(answered.body) === "name_in_use";
              return answered.ok
                ? { status: answered.status, body: answered.body }
                : { failed: answered.why };
            }),
          ),
        ).pipe(
          Effect.map((started) =>
            started.kind === "started" || (started.kind === "over-total" && !unavailable)
              ? started
              : unavailable
                ? {
                    kind: "refused" as const,
                    message: `${server.server} can't start machines now. Spawn again in a few minutes with the same clientRequestId, or leave out sandbox to run the worker on your machine.`,
                    unknown: true as const,
                  }
                : spent
                  ? {
                      kind: "refused" as const,
                      message: `The machine name ${ask.name} can't be used there: its machine was reclaimed, or another start placed it elsewhere first. It isn't asked for again. Spawn again with another clientRequestId for a new machine, or leave out sandbox to run the worker on your machine.`,
                    }
                  : started,
          ),
          Effect.tap((started) =>
            Effect.sync(() => {
              offered.delete(offeredKey);
              if (
                (started.kind === "refused" && started.unknown !== true) ||
                started.kind === "over-total"
              ) {
                deps.starting?.delete(ask.name);
                if (owned) deps.owed?.remove(ask.name, owing);
              }
            }),
          ),
        );
      }),
    theirs: mine,
    arrive: (name) =>
      Effect.gen(function* () {
        const deadline = now() + (deps.timeoutMs ?? ARRIVE_TIMEOUT_MS);
        const taken = named(name);
        if (taken !== undefined && aside(taken.id)) hosts.machines.setAside?.(taken.id, undefined);
        let relayed = false;
        let woken = false;
        let notFound = 0;
        for (;;) {
          const machine = named(name);
          if (machine?.onlineSince !== undefined) {
            const connected =
              hosts.connection === undefined
                ? undefined
                : yield* hosts.connection(HostId.make(machine.id)).pipe(Effect.option);
            if (
              connected?._tag === "Some" &&
              !hostServes(connected.value.hello, "app-tools-tunnel")
            )
              return { failed: noAppToolsTunnel(name) };
            return machine.id;
          }
          const left = deadline - now();
          if (left <= 0) return { failed: "timeout" };
          const before = sentOf(deps.sent, name);
          const read = yield* port
            .call(origin, "status", { name }, { account: accountNow() })
            .pipe(Effect.timeoutOption(left));
          if (read._tag === "None") return { failed: "timeout" };
          const answered = read.value;
          const fresh = answered.ok && settledSince(deps.sent, name, before);
          const status = fresh ? parseMachineStatus(answered.body) : {};
          if (fresh && machine !== undefined)
            hosts.providerSaid?.(HostId.make(machine.id), providerWordOf(status, now()));
          const why = status.message ?? `${server.server} says it isn't starting.`;
          notFound = fresh && isNotFound(answered) ? notFound + 1 : 0;
          if (notFound >= RECLAIMED_AFTER_MISSES && machine === undefined)
            return { failed: failedWords(name, why) };
          if (fresh && answered.status < 300) {
            if (status.phase === "failed" && (woken || machine === undefined)) {
              if (machine !== undefined) {
                deps.asleep?.add(name);
                port.unrelay(name);
              }
              return {
                failed: woken
                  ? `The machine ${name} failed there after it was started again: ${why}`
                  : failedWords(name, why),
              };
            }
            if ((status.phase === "stopped" || status.phase === "failed") && !woken) {
              const waking = yield* wakeSignedIn(
                port,
                { name, via: origin, account: accountNow() },
                { ...deps, heldFor },
              ).pipe(Effect.timeoutOption(Math.max(0, deadline - now())));
              if (waking._tag === "None") return { failed: "timeout" };
              const woke = waking.value;
              if (woke !== "retry" && woke !== "gone") woken = true;
              if (woke === "refused")
                return {
                  failed: `The machine ${name} is ${status.phase} there and couldn't be started again.`,
                };
            }
            if (machine === undefined && status.publicKey !== undefined) {
              const full = yield* roomFor(port, hosts, deps, resting, deadline - now());
              if (full !== undefined) return { failed: full };
              const result = hosts.machines.provision({
                name,
                publicKey: status.publicKey,
                platform: status.platform ?? "linux",
                onDemand: "worker",
                via: origin,
                ...viaField(),
                viaName: plainName(server.server),
              });
              if (result.kind === "refused") return { failed: failedWords(name, result.message) };
              releaseOwed(name);
            }
          }
          if (named(name) !== undefined && !relayed) {
            port.relay(origin, name, accountNow());
            relayed = true;
          }
          if (now() >= deadline) return { failed: "timeout" };
          yield* Effect.sleep(deps.everyMs ?? ARRIVE_EVERY_MS);
        }
      }).pipe(Effect.ensuring(Effect.sync(() => deps.starting?.delete(name)))),
    timedOut: (name) =>
      Effect.map(forget(name), (stopped) => {
        const within = `The machine ${name} didn't join within ${Math.round((deps.timeoutMs ?? ARRIVE_TIMEOUT_MS) / 60_000)} minutes`;
        return stopped
          ? `${within}, so it was stopped. Spawn again to ask for a new one, or leave out sandbox to run the worker on your machine.`
          : `${within}, and ${server.server} didn't confirm stopping it: it stays listed under Machines until the server reclaims it. Leave out sandbox to run the worker on your machine.`;
      }),
  };
};

/** The desktop's signed-in worker machines: the source for `sandbox`, and the relay it carries. */
export class SignedInWorkers extends Context.Service<
  SignedInWorkers,
  {
    readonly port: WorkerMachinePortShape;
    /** The signed-in server to ask now, as a source, or why there is none. */
    readonly source: Effect.Effect<
      | { readonly source: WorkerMachineSource; readonly server: WorkerMachineServer }
      | { readonly refused: string }
    >;
    /**
     * Sets hosted worker machines aside, and takes them back (`setAsideStoppedSignedIn`,
     * `takeBackSetAside`). Absent without the app.
     */
    readonly setAside?: {
      /** Sets one aside once its server says it is stopped and `final` still lets it go. */
      readonly stopped: (id: string, final: FinalCheck) => Effect.Effect<boolean>;
      /** Takes one back: a thread here needs it again. */
      readonly takeBack: (id: string) => void;
    };
  }
>()("@gram/server/SignedInWorkers") {}

/** How often the app is told the whole list of machines it carries, whether or not it changed. */
export const RELAYS_RESYNC = Duration.minutes(1);
/**
 * Provides `SignedInWorkers` in the desktop app, where there are joined machines to register
 * worker hosts with; takes each relayed connection; and asks the app, once at start, to carry
 * every relayed worker host's connection again.
 */
export const SignedInWorkersLive = Layer.effect(
  SignedInWorkers,
  Effect.gen(function* () {
    const app = yield* WorkerMachinePort;
    const hosts = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
    if (!app.available || hosts === undefined)
      return { port: app, source: Effect.succeed({ refused: NO_SIGNED_IN_SERVER } as const) };
    const port = fencedCalls(app);
    const offered: OfferedByServer = new Map();
    const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
    const owed = config === undefined ? memoryOwedStops() : fileOwedStops(config.dataDir);
    const starting = new Set<string>();
    const locks: NameLocks = makeKeyedLock<string>();
    const asleep = new Set<string>(setAsideNames(hosts));
    const sent: StartsSent = new Map();
    const claimed = claimedHere(hosts);
    const dials = yield* Queue.unbounded<RelayedDial>();
    port.onDial((dial) => {
      Queue.offerUnsafe(dials, dial);
    });
    yield* Queue.take(dials).pipe(
      Effect.flatMap((dial) =>
        takeRelayedDial(hosts, dial).pipe(
          Effect.catchCause((cause) => Effect.logWarning("a relayed dial failed", cause)),
          Effect.forkScoped,
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    const relayed = () =>
      relaysOf(
        hosts,
        restingBy(asleep, (id) => hosts.machines.get(id)?.setAside !== undefined),
      );
    let told = "";
    const sync = (fresh: boolean) => {
      const machines = relayed();
      const said = JSON.stringify(machines);
      if (!fresh && said === told) return;
      told = said;
      port.relays(machines, fresh);
    };
    sync(true);
    const unwatch = hosts.watch(() => sync(false));
    yield* Effect.addFinalizer(() => Effect.sync(unwatch));
    const { adopt, adoptAll, markOf } = signInMarks(port, hosts, owed);
    yield* Effect.forkScoped(adoptAll);
    const signIns = yield* Queue.sliding<void>(1);
    port.onSignIns(() => {
      Queue.offerUnsafe(signIns, undefined);
    });
    yield* Queue.take(signIns).pipe(Effect.andThen(adoptAll), Effect.forever, Effect.forkScoped);
    yield* Effect.sleep(RELAYS_RESYNC).pipe(
      Effect.andThen(adoptAll),
      Effect.andThen(
        Effect.sync(() => {
          told = "";
          sync(false);
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    const wokenFor = new Map<string, number>();
    const goneFor = new Map<string, number>();
    const wants = yield* Queue.unbounded<void>();
    const wakeWanted = Effect.suspend(() => {
      takeBackSetAside(hosts, starting);
      return Effect.forEach(
        hosts.list(),
        (machine) => {
          if (
            machine.via === undefined ||
            machine.onDemand !== "worker" ||
            machine.onlineSince !== undefined
          )
            return Effect.void;
          const since = hosts.stops.wantedSince(HostId.make(machine.id));
          if (since === undefined) {
            wokenFor.delete(machine.id);
            goneFor.delete(machine.id);
            return Effect.void;
          }
          if (wokenFor.get(machine.id) === since) return Effect.void;
          wokenFor.set(machine.id, since);
          const id = HostId.make(machine.id);
          return wakeSignedIn(
            port,
            { name: machine.name, via: machine.via, account: machine.viaAccount },
            {
              locks,
              asleep,
              sent,
              wanted: () => hosts.stops.wanted(id),
              said: (word) => hosts.providerSaid?.(id, word),
              heldFor: (name) => {
                const until = owed.holds.until(machine.via!, name, Date.now());
                return until === undefined ? 0 : until - Date.now();
              },
            },
          ).pipe(
            Effect.flatMap((woke) =>
              Effect.gen(function* () {
                sync(false);
                const missed = woke === "gone" ? (goneFor.get(machine.id) ?? 0) + 1 : 0;
                if (missed === 0) goneFor.delete(machine.id);
                else goneFor.set(machine.id, missed);
                if (woke === "refused" || woke === "unwanted") return;
                if (missed >= RECLAIMED_AFTER_MISSES) {
                  goneFor.delete(machine.id);
                  return;
                }
                yield* Effect.sleep(WAKE_RETRY_MS);
                if (wokenFor.get(machine.id) === since) wokenFor.delete(machine.id);
                Queue.offerUnsafe(wants, undefined);
              }),
            ),
            Effect.catchCause((cause) => Effect.logWarning("a worker machine wake failed", cause)),
            Effect.forkScoped,
          );
        },
        { discard: true },
      );
    });
    const unwatchWants = hosts.watch(() => {
      Queue.offerUnsafe(wants, undefined);
    });
    yield* Effect.addFinalizer(() => Effect.sync(unwatchWants));
    yield* Queue.take(wants).pipe(Effect.andThen(wakeWanted), Effect.forever, Effect.forkScoped);
    yield* askOnDrop(port, hosts);
    const misses = new Map<string, number>();
    const stopMisses = new Map<string, number>();
    const heardFrom = (server: WorkerMachineServer) => {
      hosts.hostedLogo?.(server.origin, server.logo);
      return adopt(server);
    };
    yield* port.server().pipe(
      Effect.tap((answered) => Effect.sync(() => answered.ok && heardFrom(answered.server))),
      Effect.andThen(forgetReclaimed(port, hosts, misses, asleep, sent)),
      Effect.tap(() => Effect.sync(() => sync(false))),
      Effect.andThen(
        settleOwedStops(
          port,
          owed,
          claimed,
          Date.now,
          locks,
          (name) => starting.has(name),
          stopMisses,
        ),
      ),
      Effect.catchCause((cause) => Effect.logWarning("the reclaimed-machine pass failed", cause)),
      Effect.repeat(Schedule.spaced(RECLAIMED_EVERY)),
      Effect.forkScoped,
    );
    return {
      port,
      setAside: {
        stopped: (id: string, final: FinalCheck) =>
          setAsideStoppedSignedIn(port, hosts, { locks, asleep, sent, starting }, id, final),
        takeBack: (id: string) => takeBackSetAside(hosts, starting, (each) => each === id),
      },
      source: port.server().pipe(
        Effect.tap((answered) => Effect.sync(() => answered.ok && heardFrom(answered.server))),
        Effect.map((answered) =>
          answered.ok
            ? {
                source: signedInSource(answered.server, {
                  port,
                  hosts,
                  offered,
                  owed,
                  starting,
                  locks,
                  asleep,
                  sent,
                  markOf,
                }),
                server: answered.server,
              }
            : {
                refused:
                  answered.why === NO_APP || answered.why === NO_SIGNED_IN_SERVER
                    ? NO_SIGNED_IN_SERVER
                    : `${answered.why} ${NO_SIGNED_IN_SERVER}`,
              },
        ),
      ),
    };
  }),
);
