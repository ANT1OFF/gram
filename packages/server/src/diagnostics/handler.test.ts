import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { InvalidState, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import pino from "pino";
import { MAX_LINE_CHARS } from "../app-tools/diagnostics-tools.ts";
import { AppToolRegistry, bindAppTools } from "../app-tools/registry.ts";
import { localDay } from "../logging/daily-file.ts";
import { ServerLog } from "../logging/service.ts";
import { makeRuntimeTestLayer } from "../runtime/test-harness.ts";
import { editorHandlers } from "../rpc/handlers/editor.ts";
import { type LaunchSpec, Opener } from "../platform/opener.ts";
import { diagnosticsHandlers } from "./handler.ts";

const tempLogDir = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "gram-diagnostics-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  return dir;
});

const logAt = (logDir: string) =>
  Layer.succeed(ServerLog, {
    logger: pino({ enabled: false }),
    logDir,
    setLevel: () => Effect.void,
  });

const line = (fields: Record<string, unknown>) =>
  JSON.stringify({ time: "2026-10-08T10:00:00.000Z", level: 30, ...fields });

describe("diagnostics handlers", () => {
  it.effect("reports redacted log tails and opens the folder through the opener", () =>
    Effect.gen(function* () {
      const logDir = yield* tempLogDir;
      writeFileSync(
        join(logDir, `server-${localDay(new Date())}.log`),
        [
          JSON.stringify({ level: 30, time: "t1", msg: "first" }),
          JSON.stringify({ level: 50, time: "t2", msg: "boot http://127.0.0.1:1/?boot=abcdef" }),
          "",
        ].join("\n"),
      );
      const opened: string[] = [];
      const handlers = yield* diagnosticsHandlers.pipe(
        Effect.provide(
          Layer.mergeAll(
            logAt(logDir),
            Layer.succeed(Opener, {
              launch: ({ args }) =>
                Effect.sync(() => {
                  opened.push(args.at(-1) ?? "");
                }),
            }),
          ),
        ),
      );

      const report = yield* handlers["app.diagnosticsReport"]({ logLines: 1 });
      expect(report.logDir).toBe(logDir);
      expect(report.text).toContain("Version: 0.0.0-dev");
      expect(report.text).toContain("t2 ERROR boot http://127.0.0.1:1/?boot=[redacted]");
      expect(report.text).not.toContain("first");
      expect(report.text).not.toContain("abcdef");

      yield* handlers["app.openLogsFolder"]();
      expect(opened).toEqual([logDir]);
    }).pipe(Effect.provide(makeRuntimeTestLayer())),
  );

  it.effect(
    "registers read_app_logs, which keeps to the caller's lines unless asked for the app's",
    () =>
      Effect.gen(function* () {
        const logDir = yield* tempLogDir;
        writeFileSync(
          join(logDir, `server-${localDay(new Date())}.log`),
          [
            line({ msg: "server started" }),
            line({ threadId: "t-mine", msg: "session started" }),
            line({ threadId: "t-other", level: 50, msg: "other thread failed" }),
            line({
              threadId: "t-mine",
              level: 50,
              msg: "mcp server exited",
              time: "2026-10-08T11:00:00.000Z",
            }),
            "a line that isn't JSON",
            "",
          ].join("\n"),
        );
        yield* diagnosticsHandlers.pipe(Effect.provide(logAt(logDir)));
        const definition = (yield* AppToolRegistry).definitions.find(
          (d) => d.descriptor.name === "read_app_logs",
        );
        const [tool] = bindAppTools([definition!], "t-mine" as ThreadId);
        expect(tool!.descriptor.class).toBe("read");

        expect(yield* tool!.run({})).toEqual({
          lines: [
            '2026-10-08T10:00:00.000Z INFO session started {"threadId":"t-mine"}',
            '2026-10-08T11:00:00.000Z ERROR mcp server exited {"threadId":"t-mine"}',
          ],
          truncated: false,
        });
        expect(yield* tool!.run({ level: "error", since: "2026-10-08T10:30:00Z" })).toEqual({
          lines: ['2026-10-08T11:00:00.000Z ERROR mcp server exited {"threadId":"t-mine"}'],
          truncated: false,
        });
        const app = (yield* tool!.run({ scope: "app", lines: 2 })) as {
          lines: ReadonlyArray<string>;
          truncated: boolean;
        };
        expect(app).toEqual({
          lines: [
            '2026-10-08T11:00:00.000Z ERROR mcp server exited {"threadId":"t-mine"}',
            "a line that isn't JSON",
          ],
          truncated: true,
        });
        expect(JSON.stringify(yield* tool!.run({ scope: "app", level: "warn" }))).toContain(
          "other thread failed",
        );
        const error = yield* tool!.run({ since: "yesterday" }).pipe(Effect.flip);
        expect(error.message).toContain("ISO date-time");

        // One huge entry is cut, not left to crowd out every line before it.
        const today = join(logDir, `server-${localDay(new Date())}.log`);
        appendFileSync(
          today,
          `${line({ threadId: "t-mine", level: 50, msg: "checkpoint failed", reason: "x".repeat(60_000) })}\n`,
        );
        const huge = (yield* tool!.run({})) as { lines: ReadonlyArray<string> };
        expect(huge.lines).toHaveLength(3);
        expect(huge.lines.at(-1)).toMatch(/checkpoint failed .*…\[cut\]$/);
        expect(huge.lines.at(-1)!.length).toBeLessThanOrEqual(MAX_LINE_CHARS + 10);

        // A log longer than one call reads says so, even when what it read has no match.
        appendFileSync(today, `${line({ msg: "filler" })}\n`.repeat(70_000));
        expect(yield* tool!.run({ level: "error", since: "2026-10-08T12:00:00Z" })).toEqual({
          lines: [],
          truncated: true,
          olderNotRead: true,
        });
      }).pipe(Effect.provide(makeRuntimeTestLayer())),
  );

  it.effect("creates a missing logs folder and opens it in a window that shows", () =>
    Effect.gen(function* () {
      const logDir = join(yield* tempLogDir, "not", "yet");
      const launched: LaunchSpec[] = [];
      const handlers = yield* diagnosticsHandlers.pipe(
        Effect.provide(
          Layer.mergeAll(
            logAt(logDir),
            Layer.succeed(Opener, {
              launch: (spec) => Effect.sync(() => void launched.push(spec)),
            }),
          ),
        ),
      );

      yield* handlers["app.openLogsFolder"]();
      expect(existsSync(logDir)).toBe(true);
      // Explorer started hidden opens the folder in an invisible window, and nothing fails.
      expect(launched).toEqual([expect.objectContaining({ args: [logDir], window: true })]);
    }).pipe(Effect.provide(makeRuntimeTestLayer())),
  );

  it.effect("fails with the opener's reason when the folder can't be opened", () =>
    Effect.gen(function* () {
      const logDir = yield* tempLogDir;
      const handlers = yield* diagnosticsHandlers.pipe(Effect.provide(logAt(logDir)));
      const error = yield* handlers["app.openLogsFolder"]().pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidState);
      expect(error.message).toMatch(/^Can't start (open|explorer\.exe|xdg-open) here$/);
    }).pipe(Effect.provide(makeRuntimeTestLayer())),
  );

  it.effect("fails with the reason when the logs folder can't be created", () =>
    Effect.gen(function* () {
      const file = join(yield* tempLogDir, "a-file");
      writeFileSync(file, "");
      const handlers = yield* diagnosticsHandlers.pipe(Effect.provide(logAt(join(file, "logs"))));
      const error = yield* handlers["app.openLogsFolder"]().pipe(Effect.flip);
      expect(error.message).toMatch(/^couldn't create .*logs: Error: E(NOTDIR|EXIST|NOENT)/);
    }).pipe(Effect.provide(makeRuntimeTestLayer())),
  );

  it.effect("opens the logs folder, and the editor and reveal on it, through the same opener", () =>
    Effect.gen(function* () {
      const logDir = yield* tempLogDir;
      const launched: LaunchSpec[] = [];
      const opener = Layer.succeed(Opener, {
        launch: (spec) => Effect.sync(() => void launched.push(spec)),
      });
      const handlers = yield* diagnosticsHandlers.pipe(
        Effect.provide(Layer.mergeAll(logAt(logDir), opener)),
      );
      const editor = yield* editorHandlers.pipe(Effect.provide(opener));

      yield* handlers["app.openLogsFolder"]();
      yield* editor["editor.open"]({ path: logDir });
      yield* editor["fs.reveal"]({ path: logDir });
      expect(launched).toHaveLength(3);
    }).pipe(Effect.provide(makeRuntimeTestLayer())),
  );
});
