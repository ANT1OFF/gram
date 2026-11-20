import { describe, expect, it } from "@effect/vitest";
import type { ProfileId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { opensOnHost, opensOnMachine } from "../runtime/host-agent-sessions.ts";
import { HOST_FEATURES } from "./protocol.ts";
import { HOST_GROK_MISSING } from "./session-gates.ts";
import { codexMachineWith, layer, THREAD } from "./sessions.testing.ts";

describe("a joined machine's Grok Build sessions", () => {
  it("open there, and a gateway profile's never does", () => {
    const plain = { threadId: THREAD, cwd: "/work" };
    expect(opensOnMachine("grok", plain)).toBe(true);
    expect(opensOnHost("grok", plain)).toBe(false);
    expect(
      opensOnMachine("grok", {
        ...plain,
        model: { agent: "grok", model: "grok-4.7", profileId: "p-1" as ProfileId },
      }),
    ).toBe(false);
  });

  it.live("start on the machine that runs them", () =>
    Effect.gen(function* () {
      const { onHost, inServer, agent } = yield* codexMachineWith(HOST_FEATURES, "grok");
      yield* agent.open({
        threadId: THREAD,
        cwd: "/work/repo",
        model: { agent: "grok", model: "grok-4.7" },
      });
      expect(inServer.opened).toEqual([]);
      expect(onHost.opened[0]).toMatchObject({ model: { agent: "grok", model: "grok-4.7" } });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("a host that doesn't run them is refused, saying why, and opens nothing", () =>
    Effect.gen(function* () {
      const { onHost, inServer, agent } = yield* codexMachineWith(
        HOST_FEATURES.filter((feature) => feature !== "agent-grok"),
        "grok",
      );
      const error = yield* agent
        .open({ threadId: THREAD, cwd: "/work", model: { agent: "grok", model: "grok-4.7" } })
        .pipe(Effect.scoped, Effect.flip);
      expect(error).toMatchObject({ _tag: "AgentUnavailable", agent: "grok" });
      expect(error.message).toBe(`On box: ${HOST_GROK_MISSING}`);
      expect(onHost.opened).toEqual([]);
      expect(inServer.opened).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
