// The self-update of `self-update.ts` on this machine's own service, filesystem and network.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type HostBusy, type HostUpdateProgress, HostUpdateRefused } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { HostUpdater } from "./protocol.ts";
import {
  appsFolder,
  handOverToSupervisor,
  makeSelfUpdate,
  probeHost,
  type SelfUpdate,
  superviseUpdate,
  unpackRelease,
} from "./self-update.ts";
import { installService, serviceCommand, servicePlatform } from "./service.ts";

/**
 * The host's updater, for a joined machine's host: `undefined` where it can't update (no release,
 * or a platform with no service), so its hello leaves `update` out.
 */
export const selfUpdater = (
  release: string | undefined,
  home: string,
  busy: Effect.Effect<HostBusy>,
): HostUpdater | undefined => {
  const platform = servicePlatform();
  if (release === undefined || platform === undefined) return undefined;
  const apps = appsFolder(home);
  const updater = makeSelfUpdate({
    release,
    platform,
    arch: process.arch,
    home,
    apps,
    current: process.env["GRAM_HOST_SERVICE"] === "1" ? serviceCommand(home) : undefined,
    busy: () => Effect.runPromise(busy),
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

/** `gram-host update-supervise`: moves the service to the new app, and back if it doesn't dial in. */
export const superviseHere = (home: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const platform = servicePlatform();
    if (platform === undefined) return;
    yield* Effect.promise(() =>
      superviseUpdate({
        home,
        apps: appsFolder(home),
        install: (command) =>
          Effect.runPromise(installService(platform, command).pipe(Effect.asVoid)),
        shim: join(homedir(), ".local", "bin", "gram-host"),
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log: (line) => process.stdout.write(`${line}\n`),
      }),
    );
  });
