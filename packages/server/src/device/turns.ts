import type {
  DeviceId,
  DeviceRefusalReason,
  SendResult,
  SignedTurnGrant,
  ThreadId,
  TurnId,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import type { Devices, OnlineDevice } from "./devices.ts";
import { turnGrantHolds } from "./keys.ts";
import { LentDevices } from "./service.ts";

/** The one turn of a thread that may ask a person's device, and what it may ask with. */
export interface DeviceTurn {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  /** Whose message started the turn: the device's person, as the front named them. */
  readonly person: string;
  readonly workspace: string;
  readonly deviceId: DeviceId;
  readonly grant: SignedTurnGrant;
  /** Requests the device refused for good in this turn, by what they asked. */
  readonly refused: Map<string, DeviceRefusalReason>;
}

export interface DeviceTurnsOptions {
  readonly devices: Pick<Devices, "list" | "ownedBy">;
  /** The public origin the person signed in to, which a grant must name. */
  readonly origin: string;
  readonly store: Pick<ThreadStoreShape, "getThread" | "lastTurn" | "listTurns" | "turnMessages">;
  readonly now?: () => number;
}

/** How long a check waits on a message being sent with a grant, to see whether it binds. */
export const BIND_WAIT = Duration.seconds(3);

const signerOf = (
  devices: Pick<Devices, "list" | "ownedBy">,
  person: string,
  signed: SignedTurnGrant,
  expected: { readonly origin: string; readonly workspace: string; readonly thread: string },
  now: number,
): OnlineDevice | undefined => {
  for (const summary of devices.list(expected.workspace)) {
    if (summary.owner !== person) continue;
    const device = devices.ownedBy(person, expected.workspace, summary.deviceId);
    if (device !== undefined && turnGrantHolds(device.publicKey, signed, expected, now))
      return device;
  }
  return undefined;
};

/**
 * Binds a person's device grant to the one turn their message starts, on a thread that person
 * started (or a workspace's orchestrator nobody started) (`docs/design/personal-device.md`,
 * "The tools and the turn binding, as built"), by the id the runtime gave that turn. The binding is
 * made only when the message starts a turn of an idle thread of the grant's workspace that no other
 * thread spawned. It holds while that turn is the thread's open one, the grant is in its time and
 * the person's message is the only input the turn has taken: a steer, another thread's message, a
 * wake or a notice joining the turn ends it for good.
 */
export const makeDeviceTurns = (options: DeviceTurnsOptions) => {
  const now = options.now ?? Date.now;
  const bound = new Map<ThreadId, DeviceTurn>();
  const binding = new Map<ThreadId, Deferred.Deferred<void>>();

  const lose = (turn: DeviceTurn) => {
    if (bound.get(turn.threadId) === turn) bound.delete(turn.threadId);
  };

  return {
    /**
     * Sends `person`'s message with the grant their device signed for it. A grant that doesn't
     * hold (another person's device, another thread or workspace, out of time, a worker's
     * thread) binds nothing and the message is sent as any other; so is one the thread queues.
     */
    sending: <E, R>(
      threadId: ThreadId,
      person: string | undefined,
      signed: SignedTurnGrant | undefined,
      send: Effect.Effect<SendResult, E, R>,
    ): Effect.Effect<SendResult, E, R> =>
      Effect.gen(function* () {
        if (signed === undefined || person === undefined) return yield* send;
        const thread = yield* options.store
          .getThread(threadId)
          .pipe(Effect.orElseSucceed(() => undefined));
        const theirs =
          thread !== undefined &&
          thread.spawnedBy === undefined &&
          thread.role !== "dream" &&
          (thread.startedBy === person ||
            (thread.startedBy === undefined && thread.role === "orchestrator"));
        const device =
          !theirs || thread.workspaceId === undefined
            ? undefined
            : signerOf(
                options.devices,
                person,
                signed,
                { origin: options.origin, workspace: thread.workspaceId, thread: threadId },
                now(),
              );
        if (device === undefined) {
          yield* Effect.logInfo("devices: a message's grant binds nothing").pipe(
            Effect.annotateLogs({ threadId }),
          );
          return yield* send;
        }
        const settled = Deferred.makeUnsafe<void>();
        binding.set(threadId, settled);
        const result = yield* send.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (binding.get(threadId) === settled) binding.delete(threadId);
            }).pipe(Effect.andThen(Deferred.succeed(settled, undefined))),
          ),
          Effect.tap((sent) =>
            Effect.sync(() => {
              if (sent.queued || sent.turnId === undefined) return;
              bound.set(threadId, {
                threadId,
                turnId: sent.turnId,
                person,
                workspace: device.workspace,
                deviceId: device.deviceId,
                grant: signed,
                refused: new Map(),
              });
            }),
          ),
        );
        return result;
      }),
    /**
     * The device turn `threadId` is in now, if any: none yet while its turn hasn't begun, and none
     * ever again once it is lost (its turn ended, its grant ran out, other input joined it). A
     * check while a message with a grant is being sent waits to see whether it binds.
     */
    current: (threadId: ThreadId): Effect.Effect<DeviceTurn | undefined> =>
      Effect.gen(function* () {
        const settling = binding.get(threadId);
        if (settling !== undefined)
          yield* Deferred.await(settling).pipe(Effect.timeoutOption(BIND_WAIT), Effect.asVoid);
        const turn = bound.get(threadId);
        if (turn === undefined) return undefined;
        const open = yield* options.store.lastTurn(threadId);
        if (open?.id !== turn.turnId && now() < turn.grant.grant.expiresAt) {
          const turns = yield* options.store.listTurns(threadId);
          if (!turns.some((entry) => entry.id === turn.turnId)) return undefined;
        }
        const inputs = yield* options.store
          .turnMessages(threadId, turn.turnId)
          .pipe(Effect.map((messages) => messages.filter((message) => message.role === "user")));
        if (
          open?.id !== turn.turnId ||
          open.endedAt !== undefined ||
          now() >= turn.grant.grant.expiresAt ||
          inputs.length !== 1
        ) {
          lose(turn);
          return undefined;
        }
        return turn;
      }),
  };
};

export type DeviceTurns = ReturnType<typeof makeDeviceTurns>;

/**
 * The device turns of this server's threads; none where nobody signs in through a front, since
 * there are no lent devices then.
 */
export class LentDeviceTurns extends Context.Service<LentDeviceTurns, DeviceTurns | undefined>()(
  "@gram/server/LentDeviceTurns",
) {
  static readonly layer = Layer.effect(
    LentDeviceTurns,
    Effect.gen(function* () {
      const devices = yield* LentDevices;
      const origin = (yield* ServerConfig).frontedIdentity?.origin;
      if (devices === undefined || origin === undefined) return undefined;
      return makeDeviceTurns({ devices, origin, store: yield* ThreadStore });
    }),
  );
}
