// The self-update of `self-update.ts` on this machine's own service, filesystem and network.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type HostBusy, type HostUpdateProgress, HostUpdateRefused } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { HostUpdater } from "./protocol.ts";
import type { Admission } from "./admission.ts";
import {
  appsFolder,
  handOverToSupervisor,
  makeSelfUpdate,
  PLAN_ID,
  probeHost,
  recoverUpdate,
  releaseAsset,
  type SupervisorMode,
  type SelfUpdate,
  superviseUpdate,
  unpackRelease,
} from "./self-update.ts";
import { installService, serviceCommand, servicePlatform } from "./service.ts";

/**
 * The host's updater, for a joined machine's host: `undefined` where it can't update (no release,
 * no service of its own to move, or a platform Gram ships no release for), so its hello leaves
 * `update` out and the main Gram offers the installer instead.
 */
export const selfUpdater = (
  release: string | undefined,
  home: string,
  busy: Effect.Effect<HostBusy>,
  admission: Admission,
): HostUpdater | undefined => {
  const platform = servicePlatform();
  if (
    release === undefined ||
    platform === undefined ||
    process.env["GRAM_HOST_SERVICE"] !== "1" ||
    releaseAsset(release, platform, process.arch) === undefined
  )
    return undefined;
  const apps = appsFolder(home);
  const updater = makeSelfUpdate({
    release,
    platform,
    arch: process.arch,
    home,
    apps,
    current: serviceCommand(home),
    busy: () => Effect.runPromise(busy),
    admission,
    fetch: (input, init) => fetch(input, init),
    unpack: async (archive, into) => {
      await unpackRelease(platform)(archive, into);
    },
    probe: probeHost,
    handOver: handOverToSupervisor(platform),
    now: Date.now,
  });
  return hostUpdaterOf(updater, () => mkdirSync(apps, { recursive: true, mode: 0o700 }));
};

/** The updater as the protocol serves it: its steps as a stream, its refusal as the stream's error. */
export const hostUpdaterOf = (
  updater: SelfUpdate,
  before: () => void = () => undefined,
): HostUpdater => ({
  check: Effect.promise(() => updater.check()),
  start: (wanted) =>
    Stream.callback<HostUpdateProgress, HostUpdateRefused>((queue) =>
      Effect.promise(async () => {
        before();
        return updater.start(wanted, (step) => {
          Queue.offerUnsafe(queue, step);
        });
      }).pipe(
        Effect.flatMap((refused) =>
          refused === undefined
            ? Queue.end(queue)
            : Queue.fail(queue, new HostUpdateRefused(refused)),
        ),
        Effect.forkScoped,
      ),
    ),
});

/**
 * `gram-host update-supervise <id> [rollback]`: moves the service to the new app, and back if it
 * doesn't dial in; with `rollback`, only back.
 */
export const superviseHere = (home: string, args: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const platform = servicePlatform();
    const [id, modeWord] = args;
    if (platform === undefined || id === undefined || !PLAN_ID.test(id)) return;
    const mode: SupervisorMode = modeWord === "rollback" ? "rollback" : "switch";
    yield* Effect.promise(() =>
      superviseUpdate(
        {
          home,
          apps: appsFolder(home),
          install: (command) =>
            Effect.runPromise(installService(platform, command).pipe(Effect.asVoid)),
          shim: join(homedir(), ".local", "bin", "gram-host"),
          now: Date.now,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          log: (line) => process.stdout.write(`${line}\n`),
        },
        id,
        mode,
      ),
    );
  });

/**
 * For `gram-host run`: an update a reboot or crash left without its supervisor is finished or
 * rolled back, now and each minute while one is unfinished.
 */
export const recoverHere = (home: string, release: string | undefined): Effect.Effect<void> => {
  const platform = servicePlatform();
  if (platform === undefined) return Effect.void;
  const once = Effect.promise(() =>
    recoverUpdate({ home, release, now: Date.now, handOver: handOverToSupervisor(platform) }).catch(
      (error: unknown) => {
        process.stdout.write(
          `gram-host: couldn't recover an unfinished update: ${String(error)}\n`,
        );
        return undefined;
      },
    ),
  );
  return once.pipe(
    Effect.repeat({ schedule: Schedule.spaced("1 minute"), until: (done) => done !== undefined }),
    Effect.asVoid,
  );
};
