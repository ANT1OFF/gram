import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { InvalidState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import pino from "pino";
import { diagnosticsHandlers } from "../diagnostics/handler.ts";
import { ServerLog } from "../logging/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { openExternal } from "../ports/open-external.ts";
import { editorHandlers } from "../rpc/handlers/editor.ts";
import { makeRuntimeTestLayer } from "../runtime/test-harness.ts";
import { fencedOpener, Opener, OPENER_FENCED, OpenerLive, openerFenced } from "./opener.ts";

/** An opener that records each launch, fenced: what a headless or fronted server gets. */
const recordingFenced = (launched: Array<string>) =>
  Layer.succeed(Opener, {
    refusal: fencedOpener.refusal,
    launch: ({ file }) => Effect.sync(() => void launched.push(file)),
  });

describe("a server with no local user", () => {
  it("is headless, or signed in to through a proxy", () => {
    expect(openerFenced({})).toBe(false);
    expect(openerFenced({ headless: false })).toBe(false);
    expect(openerFenced({ headless: true })).toBe(true);
    expect(openerFenced({ frontedIdentity: { issuer: "x" } })).toBe(true);
  });

  it.effect("gets the fenced opener, which starts nothing", () =>
    Effect.gen(function* () {
      const opener = yield* Opener;
      expect(opener.refusal).toBe(OPENER_FENCED);
      const refused = yield* opener.launch({ file: "/bin/true", args: [] }).pipe(Effect.flip);
      expect(refused).toEqual(new InvalidState({ message: OPENER_FENCED }));
    }).pipe(Effect.provide(OpenerLive(undefined, { fenced: true }))),
  );

  it.effect("refuses editor.open and fs.reveal before any path or setting is read", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-fence-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const store = yield* ThreadStore;
      yield* store.updateSettings(
        (settings) => ({ ...settings, editor: { command: "/bin/sh -c {path}" } }),
        [["editor", "command"]],
      );
      const launched: Array<string> = [];
      const editor = yield* editorHandlers.pipe(Effect.provide(recordingFenced(launched)));
      for (const path of [dir, join(dir, "missing"), "relative"]) {
        const opened = yield* editor["editor.open"]({ path }).pipe(Effect.flip);
        expect(opened).toEqual(new InvalidState({ message: OPENER_FENCED }));
        const revealed = yield* editor["fs.reveal"]({ path }).pipe(Effect.flip);
        expect(revealed).toEqual(new InvalidState({ message: OPENER_FENCED }));
      }
      expect(launched).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(makeRuntimeTestLayer())),
  );

  it.effect("refuses app.openExternal and app.openLogsFolder", () =>
    Effect.gen(function* () {
      const launched: Array<string> = [];
      const fenced = recordingFenced(launched);
      for (const url of ["https://example.com", "file:///etc/hosts"]) {
        const refused = yield* openExternal(url).pipe(Effect.provide(fenced), Effect.flip);
        expect(refused).toEqual(new InvalidState({ message: OPENER_FENCED }));
      }
      const logDir = join(mkdtempSync(join(tmpdir(), "gram-fence-")), "never-made");
      const handlers = yield* diagnosticsHandlers.pipe(
        Effect.provide(
          Layer.mergeAll(
            fenced,
            Layer.succeed(ServerLog, {
              logger: pino({ enabled: false }),
              logDir,
              setLevel: () => Effect.void,
            }),
          ),
        ),
      );
      const refused = yield* handlers["app.openLogsFolder"]().pipe(Effect.flip);
      expect(refused).toEqual(new InvalidState({ message: OPENER_FENCED }));
      expect(launched).toEqual([]);
    }).pipe(Effect.provide(makeRuntimeTestLayer())),
  );
});
