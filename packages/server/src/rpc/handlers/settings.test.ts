import { vi } from "vitest";
import { TurnActivity } from "../../runtime/turn-activity.ts";
import { describe, expect, it } from "@effect/vitest";
import { applySettingsPatch, embeddingOn, InvalidState } from "@gram/contracts";
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
import { localAppHeadersForTests } from "../../http/local-app.ts";
import { EMBEDDING_LOCAL_ONLY, embeddingEnabled } from "../../settings/embedding.ts";
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

describe("settings.set keep awake", () => {
  it.effect("applies disabling and resetting to the shared turn activity service", () =>
    Effect.gen(function* () {
      const handlers = yield* settingsHandlers;
      const activity = yield* TurnActivity;
      const changed = vi.spyOn(activity, "setEnabled");
      yield* handlers["settings.set"]({ patch: { agents: { keepAwake: false } } });
      yield* handlers["settings.set"]({ patch: { agents: { keepAwake: null } } });
      expect(changed.mock.calls).toEqual([[false], [true]]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

/** The server as `GRAM_EMBEDDING` starts it. */
const seeded = (embedding: boolean) =>
  ServerCore.pipe(
    Layer.provideMerge(FakeAgentAdapter),
    Layer.provideMerge(GitTurnHooksLive),
    Layer.provideMerge(gitPlatformTest()),
    Layer.provideMerge(ServerConfig.layer({ ...TEST_CONFIG, embedding })),
    Layer.orDie,
  );

describe("hosted features", () => {
  it.effect("are off by default, and only the local app turns them on", () =>
    Effect.gen(function* () {
      const handlers = yield* settingsHandlers;
      expect(yield* embeddingEnabled).toBe(false);
      // A paired phone's call carries no local-app mark: refused, and nothing is stored.
      const refused = yield* handlers["settings.set"]({
        patch: { experimental: { embedding: true } },
      }).pipe(Effect.flip);
      expect(refused).toEqual(new InvalidState({ message: EMBEDDING_LOCAL_ONLY }));
      expect(yield* embeddingEnabled).toBe(false);
      // Its other settings writes still go through.
      yield* handlers["settings.set"]({ patch: { experimental: { voiceInput: false } } });
      const on = yield* handlers["settings.set"](
        { patch: { experimental: { embedding: true } } },
        { headers: localAppHeadersForTests() },
      );
      expect(embeddingOn(on)).toBe(true);
      expect(yield* embeddingEnabled).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("are on from the start when GRAM_EMBEDDING=1 says so", () =>
    Effect.gen(function* () {
      expect(yield* embeddingEnabled).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(seeded(true))),
  );

  it.effect("stay off when GRAM_EMBEDDING=0 says so", () =>
    Effect.gen(function* () {
      expect(yield* embeddingEnabled).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(seeded(false))),
  );
});
