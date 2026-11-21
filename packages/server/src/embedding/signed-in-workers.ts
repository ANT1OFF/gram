// Machines of a worker's own for a desktop Gram's orchestrators, from a hosted server the desktop
// app is signed in to (`docs/design/desktop-worker-machines.md`).
//
// Embedded, a Gram asks its embedder's host provider for a worker's machine
// (`worker-machines.ts`). A desktop Gram has no provider of its own and holds no token, but the
// desktop app may be signed in to a hosted server that starts worker machines for a desktop. So
// this server asks the app, over Electron's `parentPort`, and the app makes each call with the
// person's sign-in: the hosted server takes the person from the token, and this server names no
// owner.
//
// The machine can't dial this Gram: the desktop is usually behind NAT. Both sides dial the hosted
// server instead, which pairs them: the host dials it as its origin, and the app dials its relay
// for that machine. The app passes each relayed connection here as frames over the same port, and
// this Gram takes it as any dial, by the host's own signature over the hosted server's origin, once.
// This Gram registers the machine itself, from the key the server's status reports for the name it
// asked for, as a worker host that came through that server (`PairedMachine.via`): taken only from
// that server's relay, and the desktop's own, like a joined machine.

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
import {
  claimedHere,
  forgetReclaimed,
  isLegacyRelayed,
  RECLAIMED_EVERY,
} from "./signed-in-reclaim.ts";
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
  stopOutcome,
  stopSendBy,
  stopSettled,
  UNANSWERED_STOP_HOLD_MS,
  withName,
} from "./worker-machine-stops.ts";

export * from "./signed-in-port.ts";
export * from "./signed-in-reclaim.ts";
export * from "./signed-in-calls.ts";
export * from "./worker-machine-stops.ts";

// ---------------------------------------------------------------------------------------------
// A provider of worker machines, as `spawn_worker`'s `sandbox` and the release pass use one.

/** The most machines from hosted servers this Gram registers at once (and the app relays). */
export const RELAYED_MOST = 32;

/** How many times a machine given back is asked to stop, and the wait between. */
const STOP_ATTEMPTS = 3;
const STOP_RETRY_MS = 2_000;
/** How long a wake that met only a passing error waits before it is tried again. */
export const WAKE_RETRY_MS = 5_000;

/** How long a desktop waits for a hosted machine to join before it stops it. */
export const ARRIVE_TIMEOUT_MS = 5 * 60_000;
const ARRIVE_EVERY_MS = 2_000;

/**
 * A server's name as an orchestrator reads it, in its prompt and its tools' words: one line of
 * printable text, at most 60 characters, so a name can't pass for instructions.
 */
export const plainName = (name: string): string => {
  const flat = [...name]
    .map((char) => (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const cut = [...flat].slice(0, 60).join("");
  return cut === "" ? "The hosted server" : cut;
};

/** What an orchestrator is told when the signed-in server's answer stops a machine joining. */
const failedWords = (name: string, why: string) => `The machine ${name} didn't join: ${why}`;

export interface SignedInDeps {
  readonly port: WorkerMachinePortShape;
  readonly hosts: Pick<RemoteHostsShape, "remove"> & {
    readonly list: () => ReadonlyArray<ProvidedMachine>;
    /** Its host's hello once online, to refuse one that can't carry app tools; absent in fakes. */
    readonly connection?: RemoteHostsShape["connection"];
    readonly machines: Pick<RemoteHostsShape["machines"], "provision">;
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
  /** The sign-in this source asks under: every call carries it, and everything it makes. */
  const account = server.account;
  const offered: OfferedByServer = deps.offered ?? new Map();
  const offeredKey = workerMachineIdentity(origin, account);
  // One registered under another sign-in there is that sign-in's, never this one's to act on;
  // one registered before sign-ins were kept is taken as this one's, but never forgotten on what
  // another sign-in might say of it (`isLegacyRelayed`).
  const mine = (machine: ProvidedMachine) =>
    machine.onDemand === "worker" &&
    machine.via === origin &&
    machine.owner === undefined &&
    (machine.viaAccount === undefined || machine.viaAccount === account);
  const named = (name: string) => hosts.list().find((each) => each.name === name && mine(each));
  /**
   * A machine of `name` there registered under another sign-in (the same person before they
   * signed in again, say): frozen for this one. A start of its name would reach that machine's
   * disk, and a stop of it delete it, so neither is ever sent under this sign-in.
   */
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
  /** How long a stop of `name` sent there may still land (`StopHolds`): no start goes before. */
  const heldFor = (name: string) => {
    const until = deps.owed?.holds.until(origin, name, now());
    return until === undefined ? 0 : until - now();
  };
  /** One `…/choices` call, kept a short while: the picks it offers and the models it runs. */
  const asked = Effect.gen(function* () {
    const kept = offered.get(offeredKey);
    if (kept !== undefined && now() - kept.at < CHOICES_TTL_MS) return kept;
    const answered = yield* port.call(origin, "choices", {}, { account });
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
  /**
   * Stops a machine there, a few times if need be, and forgets it here once it is stopped (or the
   * server knows it no more). One that couldn't be stopped stays registered here, so the release
   * pass still tells the server its work is over, and the server reclaims it as it does an idle
   * one. Whether it was stopped. Never cut short once begun: a stop sent may still reach the
   * server after its caller gave up, so its attempts, its hold and what it owes all run to their
   * end (each call has its own deadline), and no start of the name goes out meanwhile.
   */
  const forget = (name: string, unsettled = false) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        // Another sign-in's machine has the name: a stop of it might delete that machine's disk,
        // so none is sent, and nothing is owed that one day could be.
        if (frozen(name) !== undefined) {
          deps.starting?.delete(name);
          yield* Effect.logWarning(
            "a worker machine was not given back: another sign-in's machine has its name",
          ).pipe(Effect.annotateLogs({ machine: name }));
          return false;
        }
        // A start of unknown outcome with no owing of its own here was never admitted, so nothing
        // of it was sent: nothing to give back, and nothing to owe.
        if (
          unsettled &&
          deps.owed !== undefined &&
          named(name) === undefined &&
          !deps.owed.list().some((each) => ownsOwing(each, origin, name, account))
        ) {
          deps.starting?.delete(name);
          return true;
        }
        deps.starting?.delete(name);
        let stopped = false;
        let last = "";
        // The name is this give-back's through every attempt (`withName`): a start of it waits for
        // the last, so a stop tried again never lands on the machine a retry has since made. One
        // the app didn't answer may still reach the server late, so the name is kept a while more.
        yield* withName(
          deps.locks,
          name,
          Effect.gen(function* () {
            let unanswered = false;
            for (let attempt = 0; attempt < STOP_ATTEMPTS && !stopped; attempt += 1) {
              if (attempt > 0) yield* Effect.sleep(deps.stopRetryMs ?? STOP_RETRY_MS);
              // Held before it is sent, across a restart, until its own answer comes.
              const sentAt = now();
              const held = deps.owed?.holds.hold(origin, name, stopHoldUntil(sentAt));
              // One whose hold couldn't be written down isn't sent: it is owed, and asked later.
              if (deps.owed !== undefined && held === undefined) {
                last = "its hold couldn't be written down";
                continue;
              }
              const answered = yield* port.call(
                origin,
                "stop",
                { name },
                { sendBy: stopSendBy(sentAt), account },
              );
              if (stopSettled(answered) && held !== undefined) deps.owed?.holds.answered(held);
              // "No such machine" ends nothing while a start of it may still be on its way, nor
              // for one registered before sign-ins were kept, which another may be asking after.
              const outcome = stopOutcome(answered);
              const legacy = isLegacyRelayed(named(name));
              stopped = outcome === "stopped" || (outcome === "absent" && !unsettled && !legacy);
              // A stop no one answered may still land late: a later attempt's answer is its own,
              // not that one's, so the name is held after it whatever comes next.
              if (!stopSettled(answered)) unanswered = true;
              // Only the status: what a server answers isn't written to the log.
              last = answered.ok ? `answered ${answered.status}` : "no answer";
            }
            if (unanswered) yield* Effect.sleep(deps.unansweredHoldMs ?? UNANSWERED_STOP_HOLD_MS);
          }),
        );
        if (!stopped) {
          yield* Effect.logWarning("a worker machine given back could not be stopped").pipe(
            Effect.annotateLogs({ machine: name, reason: last }),
          );
          // Registered here, the release pass tells the server; otherwise it is owed a stop, unless
          // the server is owed one of the name already (the start's own, which stands for it).
          if (
            named(name) === undefined &&
            !deps.owed?.list().some((each) => ownsOwing(each, origin, name, account))
          )
            deps.owed?.add({
              origin,
              name,
              since: now(),
              ...(unsettled ? { unsettled: true as const } : {}),
              ...(account === undefined ? {} : { account }),
              attempt: randomUUID(),
            });
          return false;
        }
        deps.owed?.release(origin, name, account);
        port.unrelay(name);
        const machine = named(name);
        if (machine !== undefined) hosts.remove(HostId.make(machine.id));
        return true;
      }),
    );
  return {
    label: plainName(server.server),
    choices: Effect.map(asked, (kept) => kept.value),
    models: Effect.map(asked, (kept) => kept.models),
    givesBack: true,
    identity: workerMachineIdentity(origin, account),
    unrelease: (name) =>
      Effect.gen(function* () {
        // Answered `not_found` `RECLAIMED_AFTER_MISSES` times in a row, a little apart: this
        // spawn doesn't wait for it. Fewer is no proof (a backend out of reach answers so too), and
        // it is waited for as any reused machine. Either way it stays registered and relayed:
        // only `forgetReclaimed` forgets one.
        for (let missed = 1; ; missed += 1) {
          const told = yield* tellSignedInRelease(port, { name, via: origin, account }, false);
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
        // A name another sign-in's machine has is left to it: nothing asked for, nothing owed.
        if (frozen(ask.name) !== undefined)
          return Effect.succeed<WorkerMachineStart>({
            kind: "refused",
            message: `The machine ${ask.name} for this request was asked for under another sign-in to ${server.server} (before you signed in again, say), so it was left as it is: this sign-in neither reuses nor stops it. Spawn again with another clientRequestId for a new machine, or remove the old one under Settings → Machines.`,
          });
        // This start takes the name: no stop owed for an earlier one may end the machine it makes.
        deps.starting?.add(ask.name);
        // Written before the start is sent, kept across a restart: a machine started there that
        // this Gram never registers is given back by the stops owed, never left running.
        const owing = {
          origin,
          name: ask.name,
          since: now(),
          unsettled: true as const,
          start: true as const,
          ...(account === undefined ? {} : { account }),
          attempt: randomUUID(),
        };
        // Asked for again: it may come back, so it is relayed once more.
        deps.asleep?.delete(ask.name);
        let unavailable = false;
        // Whether this start's owing was kept.
        let owned = false;
        let spent = false;
        // A name the server doesn't take is never sent (it would answer `400 invalid_request`).
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
            // Owed beside any before it, once the name is this start's: no stop settled meanwhile
            // lets go of it, and none written later replaces it.
            {
              ...deps,
              heldFor,
              // Asked under the sign-in this source is for, as its owing and its give-back are:
              // signed in there as someone else meanwhile, the app sends none of it.
              account,
              // Admitted, with room to owe it a stop, and owed it, in one step under the name: a
              // start with no room is refused, never sent where nothing could give it back.
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
              : // A 5xx on the way leaves its outcome unknown, whatever was answered after it.
                unavailable
                ? {
                    kind: "refused" as const,
                    message: `${server.server} can't start machines now. Spawn again in a few minutes with the same clientRequestId, or leave out sandbox to run the worker on your machine.`,
                    // A 5xx may come back for a call that reached its machines all the same:
                    // given back as a start whose outcome isn't known.
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
              // A clear refusal made nothing; one with no answer is the spawn's to give back.
              // A clear refusal made nothing: nothing to start, nothing owed.
              if (
                (started.kind === "refused" && started.unknown !== true) ||
                started.kind === "over-total"
              ) {
                deps.starting?.delete(ask.name);
                // Its own owing alone: any owed of the name before it is about a machine still there.
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
        let relayed = false;
        let woken = false;
        let notFound = 0;
        for (;;) {
          const machine = named(name);
          if (machine?.onlineSince !== undefined) {
            // One whose gram-host can't carry app tools runs no session: refused now, not later.
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
          // No later than the deadline, however long the app or the server takes to answer.
          const left = deadline - now();
          if (left <= 0) return { failed: "timeout" };
          const before = sentOf(deps.sent, name);
          const read = yield* port
            .call(origin, "status", { name }, { account })
            .pipe(Effect.timeoutOption(left));
          if (read._tag === "None") return { failed: "timeout" };
          const answered = read.value;
          // A call that went wrong on the way, or an answer asked for before a start of the name
          // since, says nothing: asked again, until the deadline.
          const fresh = answered.ok && settledSince(deps.sent, name, before);
          const status = fresh ? parseMachineStatus(answered.body) : {};
          const why = status.message ?? `${server.server} says it isn't starting.`;
          // A `404 not_found` says nothing alone, even of a machine just accepted: one not
          // registered here fails only after `RECLAIMED_AFTER_MISSES` in a row, and is asked
          // again meanwhile (`isNotFound`); any other answer starts the count afresh.
          // Only answers in a row: no answer, a stale one, or any other, starts the count afresh.
          notFound = fresh && isNotFound(answered) ? notFound + 1 : 0;
          if (notFound >= RECLAIMED_AFTER_MISSES && machine === undefined)
            return { failed: failedWords(name, why) };
          if (fresh && answered.status < 300) {
            // Failed on the start this spawn asked for, or again after it was started once more:
            // nothing to wait for. One registered here isn't relayed while it is so.
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
            // Stopped or failed there, which no dial wakes: started once more, under its name.
            // Only a settled wake counts; a passing error leaves it to the next look.
            if ((status.phase === "stopped" || status.phase === "failed") && !woken) {
              // Within what is left of this wait, however long the start or its retries take.
              const waking = yield* wakeSignedIn(
                port,
                { name, via: origin, account },
                { ...deps, heldFor },
              ).pipe(Effect.timeoutOption(Math.max(0, deadline - now())));
              if (waking._tag === "None") return { failed: "timeout" };
              const woke = waking.value;
              // `gone` is a 404, which says nothing alone: woken again at the next look.
              if (woke !== "retry" && woke !== "gone") woken = true;
              if (woke === "refused")
                return {
                  failed: `The machine ${name} is ${status.phase} there and couldn't be started again.`,
                };
            }
            if (machine === undefined && status.publicKey !== undefined) {
              // So many relays at once is a leak, not work: refused, and this one given back.
              const held = hosts.list().filter((each) => each.via !== undefined).length;
              if (held >= RELAYED_MOST)
                return {
                  failed: `This Gram already has ${held} machines from hosted servers. Remove ones no worker uses under Settings → Machines, then spawn again.`,
                };
              // Registered here by this Gram, for the name it asked for, from the server it asked.
              const result = hosts.machines.provision({
                name,
                publicKey: status.publicKey,
                platform: status.platform ?? "linux",
                onDemand: "worker",
                via: origin,
                ...(account === undefined ? {} : { viaAccount: account }),
              });
              if (result.kind === "refused") return { failed: failedWords(name, result.message) };
              // Registered here: the release pass looks after it from now on.
              deps.owed?.release(origin, name, account);
            }
          }
          if (named(name) !== undefined && !relayed) {
            port.relay(origin, name, account);
            relayed = true;
          }
          if (now() >= deadline) return { failed: "timeout" };
          yield* Effect.sleep(deps.everyMs ?? ARRIVE_EVERY_MS);
        }
      }).pipe(
        // Registered by now, or given back next: no longer a start on its way either way.
        Effect.ensuring(Effect.sync(() => deps.starting?.delete(name))),
      ),
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
  }
>()("@gram/server/SignedInWorkers") {}

/** How often the app is told the whole list of machines it carries, whether or not it changed. */
export const RELAYS_RESYNC = Duration.minutes(1);
/** Takes one relayed connection as its machine's dial, or ends it with why. */
export const takeRelayedDial = (hosts: RemoteHostsShape, dial: RelayedDial) =>
  Effect.gen(function* () {
    const machine = hosts.machines.list().find((each) => each.name === dial.name);
    if (machine?.via === undefined || machine.via !== dial.origin) {
      dial.end(4401, "unauthorized: machine not joined");
      return;
    }
    const decision = hosts.machines.authorizeConnect(dial.origin, dial.headers, "relayed");
    if (decision.kind === "refused") {
      dial.end(4000 + decision.status, decision.message);
      return;
    }
    // The relay for one machine carries that machine's dial alone, never another's it holds.
    if (decision.machine.id !== machine.id) {
      dial.end(4401, "unauthorized: another machine's dial");
      return;
    }
    yield* hosts.attach(hosts.admit(decision.machine, dial.origin), yield* dial.socket);
  });

/**
 * Provides `SignedInWorkers` in the desktop app, where there are joined machines to register
 * worker hosts with; takes each relayed connection; and asks the app, once at start, to carry
 * every relayed worker host's connection again.
 */
export const SignedInWorkersLive = Layer.effect(
  SignedInWorkers,
  Effect.gen(function* () {
    const port = yield* WorkerMachinePort;
    const hosts = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
    if (!port.available || hosts === undefined)
      return { port, source: Effect.succeed({ refused: NO_SIGNED_IN_SERVER } as const) };
    const offered: OfferedByServer = new Map();
    const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
    const owed = config === undefined ? memoryOwedStops() : fileOwedStops(config.dataDir);
    /** Names a start is on its way for: no stop owed for an earlier one may end what it makes. */
    const starting = new Set<string>();
    const locks: NameLocks = makeKeyedLock<string>();
    const asleep = new Set<string>();
    const sent: StartsSent = new Map();
    const claimed = claimedHere(hosts);
    // Each relayed connection is served in this layer's scope, and ends with it.
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
    // What the app carries is what is registered here: told whole at start (`fresh`, since a new
    // server knows none of the connections carried for the last), on every change of the machines,
    // and every minute besides, in case the app missed one.
    const relayed = () =>
      hosts
        .list()
        .filter(
          (machine) =>
            machine.via !== undefined && machine.onDemand === "worker" && !asleep.has(machine.name),
        )
        // Each carried under the sign-in it was asked for under alone: never another's.
        .map((machine) => ({
          origin: machine.via!,
          name: machine.name,
          ...(machine.viaAccount === undefined ? {} : { account: machine.viaAccount }),
        }));
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
    /**
     * Moves one sign-in's machines and stops from its former marks to its mark. Each ledger's move
     * is whole or not at all, and asked for again at every pass, so one that failed, or that a
     * restart cut short between the two, is finished by a later one: the app keeps the former
     * marks for as long as the sign-in lasts, and answers what is asked under them meanwhile.
     */
    const adopt = (marks: {
      readonly origin: string;
      readonly account?: string | undefined;
      readonly formerAccounts?: ReadonlyArray<string> | undefined;
    }) => {
      const account = marks.account;
      if (account === undefined) return;
      for (const former of marks.formerAccounts ?? []) {
        if (former === account) continue;
        try {
          hosts.machines.remark(marks.origin, former, account);
        } catch {
          // Not written, so not moved: the next pass moves it.
        }
        owed.remark(marks.origin, former, account);
      }
    };
    /** Every sign-in's move, paused or not, whichever of them new machines are asked of. */
    const adoptAll = port.marks().pipe(
      Effect.tap((marks) => Effect.sync(() => marks.forEach(adopt))),
      Effect.catchCause((cause) => Effect.logWarning("moving former sign-in marks failed", cause)),
    );
    // At start, and whenever the app says its sign-ins changed.
    yield* Effect.forkScoped(adoptAll);
    const signIns = yield* Queue.sliding<void>(1);
    port.onSignIns(() => {
      Queue.offerUnsafe(signIns, undefined);
    });
    yield* Queue.take(signIns).pipe(Effect.andThen(adoptAll), Effect.forever, Effect.forkScoped);
    // Each resync moves what every sign-in's former marks hold first, so the relays told are
    // under each sign-in's mark now.
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
    // A worker machine that work here wants (a session about to open on it waits for it, as a
    // worker resumed or a message to one does: `stops.wanting`) and that is offline is woken
    // there by a start of its name, once each time it comes to be wanted. Only a want does: never
    // a dial, nor the relays. Whether it is still wanted is read again as the start would go, and
    // a wake that met only a passing error is tried again a little later, while it is wanted.
    const wokenFor = new Map<string, number>();
    /** How many wakes in a row, for each machine's want, were answered `not_found`. */
    const goneFor = new Map<string, number>();
    const wants = yield* Queue.unbounded<void>();
    const wakeWanted = Effect.suspend(() =>
      Effect.forEach(
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
              heldFor: (name) => {
                const until = owed.holds.until(machine.via!, name, Date.now());
                return until === undefined ? 0 : until - Date.now();
              },
            },
          ).pipe(
            Effect.flatMap((woke) =>
              Effect.gen(function* () {
                // Woken, or awake there already: carried again.
                sync(false);
                // Settled for good: refused, no longer wanted, or `gone` (`not_found`)
                // `RECLAIMED_AFTER_MISSES` times in a row for this want. Otherwise it is looked
                // at again while it is wanted and still offline and registered here, since one up
                // there now may be stopped while idle before its host dials, and only a start
                // wakes it; and one `not_found` may be a backend out of reach for a while.
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
      ),
    );
    const unwatchWants = hosts.watch(() => {
      Queue.offerUnsafe(wants, undefined);
    });
    yield* Effect.addFinalizer(() => Effect.sync(unwatchWants));
    yield* Queue.take(wants).pipe(Effect.andThen(wakeWanted), Effect.forever, Effect.forkScoped);
    // A machine the server no longer knows (reclaimed after its release, or removed there) is
    // forgotten here, so its relay stops and its name is free.
    const misses = new Map<string, number>();
    const stopMisses = new Map<string, number>();
    yield* port.server().pipe(
      Effect.tap((answered) => Effect.sync(() => answered.ok && adopt(answered.server))),
      Effect.andThen(forgetReclaimed(port, hosts, misses, asleep, sent)),
      // One the pass found stopped or failed is no longer among the relays told.
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
      source: port.server().pipe(
        // What this sign-in made under its former marks is moved to its mark first, in one step,
        // before any source asks under it.
        Effect.tap((answered) => Effect.sync(() => answered.ok && adopt(answered.server))),
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
