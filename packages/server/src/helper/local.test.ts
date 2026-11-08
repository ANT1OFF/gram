import { describe, expect, it } from "@effect/vitest";
import { makeCodexHelper } from "@gram/agents/codex";
import type { AgentHost } from "@gram/agents";
import { rmSync } from "node:fs";
import * as Effect from "effect/Effect";
import { codexHelperFixture } from "@gram/agents/codex/testing";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { localHelperTransport } from "./local.ts";

describe("local Codex helper version status", () => {
  for (const version of ["0.166.0", "0.166.1", "0.167.0", "0.165.0", "unknown"])
    it.effect(`reports discovery and warning for ${version}`, () => {
      const fixture = codexHelperFixture({ GRAM_HELPER_VERSION: version });
      const helper = makeCodexHelper(fixture.config, {
        credentials: () => Effect.die("Synthetic fixture must never access gateway credentials"),
      });
      return Effect.gen(function* () {
        const statuses = yield* localHelperTransport(
          AgentHosts.fromHosts([{ kind: "codex", helper } as AgentHost]),
        ).inspect;
        const status = statuses.find((row) => row.provider === "codex")!;
        if (version === "unknown" || version === "0.165.0") {
          expect(status).toMatchObject({
            state: "unavailable",
            models: [],
            detail: expect.stringContaining("require CLI 0.166.0 or newer"),
          });
          expect(fixture.rows().some((row) => row.start)).toBe(false);
        } else {
          expect(status).toMatchObject({ state: "ready", mode: "guided" });
          expect(status.models[0]?.id).toBe("gpt-6-luna");
          expect(status.detail).toContain("Context permission applies to this provider");
          expect(status.detail?.includes("some features may misbehave")).toBe(
            version !== "0.166.0",
          );
        }
      }).pipe(
        Effect.ensuring(Effect.sync(() => rmSync(fixture.root, { recursive: true, force: true }))),
      );
    });
});
