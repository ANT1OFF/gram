import { describe, expect, it } from "@effect/vitest";
import { applySettingsPatch } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../../config.ts";
import { gitPlatformTest } from "../../git/platform.ts";
import { GitTurnHooksLive } from "../../git/turn-hooks.ts";
import { ServerCore } from "../../http/server.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { SqlClient } from "../../platform/unstable.ts";
import { FakeAgentAdapter } from "../../runtime/fake-agent.ts";
import { TEST_CONFIG } from "../../runtime/test-harness.ts";
import { settingsHandlers } from "./settings.ts";

const TestLayer = ServerCore.pipe(
  Layer.provideMerge(FakeAgentAdapter),
  Layer.provideMerge(GitTurnHooksLive),
  Layer.provideMerge(gitPlatformTest()),
  Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
  Layer.orDie,
);

const storedRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ value: string }>`SELECT value FROM settings WHERE key = 'app'`;
  return rows[0]?.value;
}).pipe(Effect.orDie);

describe("settings.get", () => {
  it.effect("returns the stored settings as they are, and writes nothing", () =>
    Effect.gen(function* () {
      const handlers = yield* settingsHandlers;
      const store = yield* ThreadStore;
      yield* store.updateSettings(
        (settings) => applySettingsPatch(settings, { layout: { focusMode: true } }),
        [["layout", "focusMode"]],
      );
      const before = yield* storedRow;

      expect(yield* handlers["settings.get"]()).toEqual(yield* store.getSettings);
      expect((yield* handlers["settings.get"]()).layout).toEqual({ focusMode: true });
      expect(yield* storedRow).toBe(before);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
