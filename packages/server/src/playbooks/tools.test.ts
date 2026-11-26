// `read_playbook` hands a thread the reviewed playbook file it names, and only the ones its role is
// offered: a plain thread has no worker-coordination playbook, and a dream has no tool at all.
import { afterAll, describe, expect, it } from "@effect/vitest";
import type { ToolAudience } from "@gram/agents";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { ServerLayer } from "../http/server.ts";
import { FakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";

const dataDir = mkdtempSync(join(tmpdir(), "gram-playbooks-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const server = ServerLayer.pipe(
  Layer.provide(FakeAgentAdapter),
  Layer.provide(TurnHooks.layerNoop),
  Layer.provide(gitPlatformTest()),
  Layer.provide(ServerConfig.layer({ ...TEST_CONFIG, dataDir })),
  Layer.orDie,
);

const onDisk = (file: string) =>
  readFileSync(
    new URL(`../../../../docs/orchestration/playbooks/${file}`, import.meta.url),
    "utf8",
  );

const readAs = (audience: ToolAudience, name: string) =>
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const tool = registry
      .forTransport("playbook-reader" as ThreadId, audience)
      .find((candidate) => candidate.descriptor.name === "read_playbook");
    if (tool === undefined) return { bound: false as const };
    return { bound: true as const, read: yield* tool.run({ name }).pipe(Effect.result) };
  });

describe("read_playbook", () => {
  it.live(
    "returns each role's playbooks as their files hold them, and no other role's",
    () =>
      Effect.gen(function* () {
        const pr = onDisk("deliver-a-pull-request.md");
        const coordinate = onDisk("coordinate-workers-and-wakes.md");
        const mock = onDisk("mock-first.md");
        for (const audience of ["orchestrator", "worker"] as const) {
          expect(yield* readAs(audience, "mock-first")).toMatchObject({
            bound: true,
            read: { _tag: "Success", success: mock },
          });
          expect(yield* readAs(audience, "deliver-a-pull-request")).toMatchObject({
            bound: true,
            read: { _tag: "Success", success: pr },
          });
          expect(yield* readAs(audience, "coordinate-workers-and-wakes")).toMatchObject({
            bound: true,
            read: { _tag: "Success", success: coordinate },
          });
        }
        expect(yield* readAs("plain", "deliver-a-pull-request")).toMatchObject({
          bound: true,
          read: { _tag: "Success", success: pr },
        });
        expect(yield* readAs("plain", "coordinate-workers-and-wakes")).toMatchObject({
          bound: true,
          read: { _tag: "Failure" },
        });
        expect(yield* readAs("plain", "mock-first")).toMatchObject({
          bound: true,
          read: { _tag: "Failure" },
        });
        expect(yield* readAs("dream", "deliver-a-pull-request")).toEqual({ bound: false });
      }).pipe(Effect.provide(server)),
    60_000,
  );
});
