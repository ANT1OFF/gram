import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { pathToFileURL } from "node:url";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

describe("ThreadRuntimes user attachments", () => {
  it.effect("creates a thread with the caller's id and records attachments as file parts", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const id = "8c1f6e0e-4a4b-4d2e-9a53-2c3b1d2e7f10" as ThreadId;
      const screenshot = "/data/attachments/8c1f6e0e/1a2b3c4d-shot.png";

      const thread = yield* runtimes.create({
        id,
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: {
          text: "what's in this?",
          attachments: [
            { path: screenshot, name: "shot.png", mediaType: "image/png" },
            { path: "/Users/x/notes.md" },
          ],
        },
      });
      expect(thread.id).toBe(id);
      const session = yield* waitFor(
        "the first send",
        fake.latest(id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      expect(session.sent[0]?.attachments?.[0]?.path).toBe(screenshot);

      const [message] = yield* store.listMessages(id);
      expect(message?.parts).toEqual([
        { type: "text", text: "what's in this?" },
        {
          type: "file",
          mediaType: "image/png",
          filename: "shot.png",
          url: pathToFileURL(screenshot).href,
        },
        {
          type: "file",
          mediaType: "application/octet-stream",
          filename: "notes.md",
          url: pathToFileURL("/Users/x/notes.md").href,
        },
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
