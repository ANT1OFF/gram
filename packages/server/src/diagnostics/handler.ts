import { mkdirSync } from "node:fs";
import { homedir, release, type as osType } from "node:os";
import { InvalidState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { readAppLogsTool } from "../app-tools/diagnostics-tools.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { refuseUnavailable, ServerConfig } from "../config.ts";
import { latestLogFile, tailLines } from "../logging/daily-file.ts";
import { logDirFor } from "../logging/logger.ts";
import { ServerLog } from "../logging/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeDiagnostics } from "../rpc/handlers/app.ts";
import type { Handlers } from "../rpc/handlers/common.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Opener } from "../platform/opener.ts";
import { openFolderCommand } from "./opener.ts";
import { formatDiagnosticsReport, type LogTail } from "./report.ts";

const DEFAULT_LOG_LINES = 200;
const LOG_NAMES = ["server", "desktop"] as const;

/** `app.diagnosticsReport` and `app.openLogsFolder`. */
export const diagnosticsHandlers = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const log = yield* ServerLog;
  const store = yield* ThreadStore;
  const runtimes = yield* ThreadRuntimes;
  const opener = yield* Opener;
  const logDir = log.logDir ?? logDirFor(config.dataDir);
  const diagnostics = makeDiagnostics({ runtimes, config, log });

  // The log folder is known here, so the tool that reads it registers from here too.
  yield* (yield* AppToolRegistry).register([readAppLogsTool(logDir)]);

  return {
    "app.diagnosticsReport": ({ logLines }) =>
      Effect.gen(function* () {
        const info = yield* diagnostics;
        const settings = yield* store.getSettings;
        const logs = yield* Effect.sync(() =>
          LOG_NAMES.flatMap((name): LogTail[] => {
            const file = latestLogFile(logDir, name);
            return file === undefined
              ? []
              : [{ name, file, lines: tailLines(file, logLines ?? DEFAULT_LOG_LINES) }];
          }),
        );
        const text = formatDiagnosticsReport({
          generatedAt: new Date(),
          diagnostics: info,
          os: { type: osType(), release: release() },
          logDir,
          settings,
          logs,
          home: homedir(),
        });
        return { text, logDir };
      }),

    "app.openLogsFolder": () =>
      refuseUnavailable("openLogsFolder").pipe(
        Effect.andThen(
          Effect.try({
            try: () => mkdirSync(logDir, { recursive: true }),
            catch: (error) =>
              new InvalidState({ message: `couldn't create ${logDir}: ${String(error)}` }),
          }),
        ),
        Effect.andThen(() => opener.launch(openFolderCommand(logDir, process.platform))),
      ),
  } satisfies Partial<Handlers>;
});
