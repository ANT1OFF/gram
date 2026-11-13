import { join } from "node:path";
import type { Diagnostics, ServerEvent, ThreadStatus, ThreadSummary } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerConfig } from "../../config.ts";
import { EventHub } from "../../events/event-hub.ts";
import { GitStatePublisher } from "../../git/publisher.ts";
import { publishMachineStates } from "../../host/machine-events.ts";
import { RemoteHosts } from "../../host/remote-hosts.ts";
import { logFileName } from "../../logging/daily-file.ts";
import { ServerLog, type ServerLogShape } from "../../logging/service.ts";
import { openExternal } from "../../ports/open-external.ts";
import { ThreadPorts, type ThreadPortsShape } from "../../ports/service.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../../usage/limit-readings.ts";
import type { Handlers } from "./common.ts";

const LIVE_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "idle",
  "running",
  "needsApproval",
  "needsInput",
]);

/** The version reported when the server runs outside the desktop shell. */
export const DEV_VERSION = "0.0.0-dev";

/** The `app.diagnostics` result, shared with the diagnostics report. */
export const makeDiagnostics = ({
  runtimes,
  config,
  log,
  ports,
}: {
  readonly runtimes: ThreadRuntimes["Service"];
  readonly config: ServerConfig["Service"];
  readonly log: ServerLogShape;
  /** Counts threads whose terminal runs a command as working; without it, `working` is left out. */
  readonly ports?: Pick<ThreadPortsShape, "busyTerminalsNow">;
}): Effect.Effect<Diagnostics> =>
  Effect.gen(function* () {
    const threads = yield* runtimes.snapshot;
    const terminals = ports === undefined ? undefined : yield* ports.busyTerminalsNow;
    const working =
      terminals === undefined
        ? undefined
        : new Set([...(yield* runtimes.working), ...terminals]).size;
    const versions: Record<string, string> = {};
    for (const [name, version] of Object.entries(process.versions)) {
      if (typeof version === "string") versions[name] = version;
    }
    return {
      version: config.appVersion ?? DEV_VERSION,
      platform: process.platform,
      arch: process.arch,
      versions,
      dataDir: config.dataDir,
      ...(log.logDir === undefined
        ? {}
        : { logFile: join(log.logDir, logFileName("server", new Date())) }),
      threads: {
        total: threads.length,
        live: threads.filter((t) => LIVE_STATUSES.has(t.status)).length,
        ...(working === undefined ? {} : { working }),
      },
      ...(config.fakeAgent ? { fakeAgent: true } : {}),
    };
  });

/** `events.subscribe`, `app.diagnostics` and `app.openExternal`; `models.list` lives in `gateway.ts`. */
export const appHandlers = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const hub = yield* EventHub;
  const config = yield* ServerConfig;
  const log = yield* ServerLog;
  const ports = yield* ThreadPorts;
  // Absent in runtime-only test layers, which watch no checkouts.
  const publisher = yield* Effect.serviceOption(GitStatePublisher);
  // Absent in runtime-only test layers, which keep no limit readings.
  const limits = yield* Effect.serviceOption(UsageLimitReadings);
  // Absent where no machine can join: every thread is then this machine's.
  const machines = yield* Effect.serviceOption(RemoteHosts);
  if (Option.isSome(machines)) yield* publishMachineStates(hub, machines.value);

  const withPorts = (summary: ThreadSummary): ThreadSummary => {
    const listening = ports.portsOf(summary.thread.id);
    const processes = ports.terminalProcessesOf(summary.thread.id);
    return {
      ...summary,
      ...(listening.length === 0 ? {} : { ports: listening }),
      ...(processes.length === 0 ? {} : { terminalProcesses: processes }),
    };
  };

  /**
   * The thread's git state as last seen, since `git.state` is only sent when it changes: without it
   * a reloaded window showed no PR badges, and a change published as it reconnected was lost.
   */
  const withGit = (summary: ThreadSummary) =>
    Option.match(publisher, {
      onNone: () => Effect.succeed(summary),
      onSome: (git) =>
        git
          .stateForThread(summary.thread)
          .pipe(
            Effect.map((state): ThreadSummary =>
              state === undefined ? summary : { ...summary, git: state },
            ),
          ),
    });

  return {
    "app.diagnostics": () => makeDiagnostics({ runtimes, config, log, ports }),

    // The native shell owns the link dialog when present.
    "app.openExternal": ({ url }) => openExternal(url, config.shellOpensLinks === true),

    "events.subscribe": () =>
      hub.serverEvents(
        Effect.gen(function* () {
          const threads = yield* runtimes.snapshot.pipe(
            Effect.flatMap((all) => Effect.forEach(all, withGit)),
          );
          const snapshot: ServerEvent = {
            type: "threads.snapshot",
            threads: threads.map(withPorts),
          };
          const events: Array<ServerEvent> = [snapshot];
          // The machines its threads run on, so a row names one before any of them changes.
          if (Option.isSome(machines))
            events.push({ type: "machines.snapshot", machines: machines.value.states() });
          // The limit readings the server kept, so the meter shows them before any agent reports.
          if (Option.isSome(limits))
            events.push({ type: "usageLimits.snapshot", limits: yield* limits.value.current });
          return events;
        }),
      ),
  } satisfies Partial<Handlers>;
});
