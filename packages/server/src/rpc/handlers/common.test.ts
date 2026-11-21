// Behind an embedder's GitHub route, a request about a thread (a PR panel's checks, its reviewers)
// reads GitHub for that thread, so the route never answers it for nobody in particular.
import { describe, expect, it } from "@effect/vitest";
import { GhCallEnv } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { vi } from "vitest";
import { logDefects } from "./common.ts";

vi.mock("../../embedding/github-relay.ts", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  ghThreadEnv: (threadId: string) => ({ GH_TOKEN: `gram-thread:${threadId}` }),
}));

const group = { requests: new Map() } as unknown as Parameters<typeof logDefects>[0];
const token = Effect.gen(function* () {
  return (yield* GhCallEnv)["GH_TOKEN"];
});

describe("an RPC handler", () => {
  it.effect("reads GitHub for the thread its request names, and as before for none", () =>
    Effect.gen(function* () {
      const handlers = logDefects(group, {
        once: ({ threadId }: { readonly threadId?: string }) =>
          Effect.map(token, (sent) => ({ threadId, sent })),
        stream: ({ threadId }: { readonly threadId?: string }) =>
          Stream.fromEffect(Effect.map(token, (sent) => ({ threadId, sent }))),
      });
      expect(yield* handlers.once({ threadId: "thr_1" })).toEqual({
        threadId: "thr_1",
        sent: "gram-thread:thr_1",
      });
      expect(yield* handlers.once({})).toEqual({ threadId: undefined, sent: undefined });
      expect(yield* Stream.runCollect(handlers.stream({ threadId: "thr_2" }))).toEqual([
        { threadId: "thr_2", sent: "gram-thread:thr_2" },
      ]);
    }),
  );
});
