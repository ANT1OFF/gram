import type { AgentEvent, GramUIMessage } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { makeRuntimeTestLayer, TEST_CONFIG, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

/** Offline browser fixture: actual capture/admission/persistence, explicitly fake provider/CLI. */
export const persistToolImagePreview = (
  dataDir: string,
  root: string,
  events: ReadonlyArray<AgentEvent>,
): Promise<ReadonlyArray<GramUIMessage>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
        model: { agent: "codex", model: "synthetic-image-provider" },
        input: { text: "Read the invented fixture images" },
      });
      const session = yield* waitFor(
        "fake image session",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* session.emit(...events);
      yield* waitFor(
        "persisted image turn",
        runtimes.status(thread.id).pipe(Effect.map((status) => status === "idle")),
      );
      return yield* store.listMessages(thread.id);
    }).pipe(
      Effect.provide(
        makeRuntimeTestLayer(TurnHooks.layerNoop, CheckoutService.layerNoGit, {
          ...TEST_CONFIG,
          dataDir,
        }),
      ),
      Effect.scoped,
    ),
  );
