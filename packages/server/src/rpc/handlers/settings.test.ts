import { vi } from "vitest";
import { TurnActivity } from "../../runtime/turn-activity.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  applySettingsPatch,
  embeddingOn,
  InvalidState,
  type SettingsPatch,
  ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { ActingPerson, LOCAL_PERSON } from "../../embedding/person.ts";
import { EventHub } from "../../events/event-hub.ts";
import { gitPlatformTest } from "../../git/platform.ts";
import { GitTurnHooksLive } from "../../git/turn-hooks.ts";
import { ServerCore } from "../../http/server.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { SqlClient } from "../../platform/unstable.ts";
import { FakeAgentAdapter } from "../../runtime/fake-agent.ts";
import { TEST_CONFIG } from "../../runtime/test-harness.ts";
import { localAppHeadersForTests } from "../../http/local-app.ts";
import { EMBEDDING_LOCAL_ONLY, embeddingEnabled } from "../../settings/embedding.ts";
import { suppliedRefusal } from "../../settings/supplied.ts";
import { hostSettingRefusal, settingsHandlers } from "./settings.ts";

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

/** A saved grid of one pane showing `id`. */
const grid = (id: string) => ({ preset: "1" as const, panes: [ThreadId.make(id)], focused: 0 });

describe("a person's own settings", () => {
  it.effect("are the one local person's with no sign-in, kept beside the shared row", () =>
    Effect.gen(function* () {
      const handlers = yield* settingsHandlers;
      const store = yield* ThreadStore;
      const hub = yield* EventHub;
      const heard: Array<string> = [];
      yield* Effect.forkScoped(
        Stream.runForEach(
          hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] }), LOCAL_PERSON),
          (event) => Effect.sync(() => heard.push(event.type)),
        ),
      );
      yield* Effect.yieldNow;

      const saved = yield* handlers["settings.set"]({
        patch: { layout: { grid: grid("t-mine"), focusMode: true } },
      });
      expect(saved.layout).toEqual({ grid: grid("t-mine"), focusMode: true });
      expect((yield* handlers["settings.get"]()).layout).toEqual(saved.layout);
      // The grid is in the person's row and the rest in the shared one.
      expect((yield* store.getSettings).layout).toEqual({ focusMode: true });
      expect(JSON.parse((yield* storedRow) ?? "{}").layout).toEqual({ focusMode: true });
      expect((yield* store.getSettingsFor(LOCAL_PERSON)).layout?.grid).toEqual(grid("t-mine"));
      // Someone a proxy signed in reads their own, which is none yet, and writes their own.
      const asAda = Effect.provideService(ActingPerson, "ada");
      expect((yield* handlers["settings.get"]().pipe(asAda)).layout).toEqual({ focusMode: true });
      yield* handlers["settings.set"]({ patch: { layout: { grid: grid("t-ada") } } }).pipe(asAda);
      expect((yield* handlers["settings.get"]().pipe(asAda)).layout?.grid).toEqual(grid("t-ada"));
      expect((yield* handlers["settings.get"]()).layout?.grid).toEqual(grid("t-mine"));
      // A window's own save is announced to no one, as before, and Ada's reached only Ada.
      yield* hub.publish({ type: "profiles.changed" });
      yield* Effect.yieldNow;
      expect(heard).toEqual(["threads.snapshot", "profiles.changed"]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("give way to what is supplied, which can't be changed", () =>
    Effect.gen(function* () {
      const handlers = yield* settingsHandlers;
      const store = yield* ThreadStore;
      yield* handlers["settings.set"]({ patch: { layout: { grid: grid("t-mine") } } });
      yield* handlers["settings.set"](
        { patch: { experimental: { embedding: true } } },
        { headers: localAppHeadersForTests() },
      );
      yield* store.putSuppliedSettings({ layout: { grid: grid("t-supplied") } });

      expect((yield* handlers["settings.get"]()).layout?.grid).toEqual(grid("t-supplied"));
      const refused = yield* handlers["settings.set"]({
        patch: { layout: { grid: grid("t-other") } },
      }).pipe(Effect.flip);
      expect(refused).toEqual(new InvalidState({ message: suppliedRefusal(["layout", "grid"]) }));
      // No longer supplied, the person's own shows again.
      yield* store.putSuppliedSettings(undefined);
      expect((yield* handlers["settings.get"]()).layout?.grid).toEqual(grid("t-mine"));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("settings that name a program or folder on the server", () => {
  it.effect("are refused whole to a signed-in person, and changed by the local app", () =>
    Effect.gen(function* () {
      const handlers = yield* settingsHandlers;
      const store = yield* ThreadStore;
      yield* handlers["settings.set"]({ patch: { editor: { command: "code -g" } } });
      const asAda = Effect.provideService(ActingPerson, "ada");
      const patches: ReadonlyArray<SettingsPatch> = [
        { editor: { command: "/bin/sh -c {path}" }, layout: { focusMode: true } },
        { editor: { command: null } },
        { terminal: { shell: "/tmp/payload" } },
        { agents: { defaultFolder: "/" } },
        { agents: { cloneFolder: "/etc" } },
      ];
      for (const patch of patches) {
        const refused = yield* handlers["settings.set"]({ patch }).pipe(asAda, Effect.flip);
        expect(refused).toBeInstanceOf(InvalidState);
        expect(refused.message).toContain("names a program or folder on the server");
      }
      expect(
        yield* handlers["settings.set"]({ patch: { editor: { command: "vim" } } }).pipe(
          asAda,
          Effect.flip,
        ),
      ).toEqual(new InvalidState({ message: hostSettingRefusal(["editor", "command"]) }));
      // Nothing of a refused patch was written.
      const stored = yield* store.getSettings;
      expect(stored.editor.command).toBe("code -g");
      expect(stored.layout?.focusMode).toBeUndefined();
      // Repeating the value changes nothing, so a whole section's save passes, as do other settings.
      yield* handlers["settings.set"]({
        patch: { editor: { command: "code -g" }, layout: { focusMode: true } },
      }).pipe(asAda);
      expect((yield* store.getSettings).layout?.focusMode).toBe(true);
      // The app on the server's own machine still changes them, signed in or not.
      yield* handlers["settings.set"](
        { patch: { editor: { command: "zed" } } },
        { headers: localAppHeadersForTests() },
      ).pipe(asAda);
      yield* handlers["settings.set"]({ patch: { terminal: { shell: "pwsh" } } });
      expect((yield* store.getSettings).editor.command).toBe("zed");
      expect((yield* store.getSettings).terminal.shell).toBe("pwsh");
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
