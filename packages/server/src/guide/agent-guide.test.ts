import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolAudience } from "@gram/agents";
import { SETTINGS_CATALOGUE, USER_ONLY_SETTINGS, type ThreadId } from "@gram/contracts";
import { afterAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { ServerLayer } from "../http/server.ts";
import { KEYBINDINGS_ERROR_FILE, KEYBINDINGS_LAST_GOOD_FILE } from "../keybindings/keybindings.ts";
import { FakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import {
  AGENT_GUIDE_FILE,
  agentGuideText,
  guideTools,
  writeServerAgentGuide,
} from "./agent-guide.ts";

const dataDir = mkdtempSync(join(tmpdir(), "gram-agent-guide-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const AUDIENCES: ReadonlyArray<ToolAudience> = ["plain", "orchestrator", "worker", "dream"];

/** The whole server, as `main.ts` runs it: every subsystem has registered its tools once it is up. */
const server = ServerLayer.pipe(
  Layer.provide(FakeAgentAdapter),
  Layer.provide(TurnHooks.layerNoop),
  Layer.provide(gitPlatformTest()),
  Layer.provide(ServerConfig.layer({ ...TEST_CONFIG, dataDir, appVersion: "9.9.9" })),
  Layer.orDie,
);

describe("the agent guide", () => {
  it.live(
    "names every tool any session is bound with, and every setting an agent can read",
    () =>
      Effect.gen(function* () {
        const registry = yield* AppToolRegistry;
        // Stands in for an older guide an agent or person edited: the start replaces it.
        writeFileSync(join(dataDir, AGENT_GUIDE_FILE), "stale");
        yield* writeServerAgentGuide({ dataDir, appVersion: "9.9.9" });
        const guide = readFileSync(join(dataDir, AGENT_GUIDE_FILE), "utf8");
        expect(guide).toContain("Written by Gram 9.9.9 each time it starts");
        expect(guide).toContain(dataDir);

        // What sessions are actually given, role by role, not what the guide was built from.
        const bound = new Set(
          AUDIENCES.flatMap((audience) =>
            registry
              .forThread("guide-thread" as ThreadId, audience)
              .map((tool) => tool.descriptor.name),
          ),
        );
        expect(bound.size).toBeGreaterThan(50);
        const missingTools = [...bound].filter((name) => !guide.includes(`### \`${name}\`\n`));
        expect(missingTools, "tools missing from the agent guide").toEqual([]);
        // One heading per name: a tool defined per role (`spawn_task`) lists each variant under it.
        for (const name of bound) expect(guide.split(`### \`${name}\`\n`)).toHaveLength(2);

        const keys = [...SETTINGS_CATALOGUE, ...USER_ONLY_SETTINGS].map((entry) => entry.key);
        const missingSettings = keys.filter((key) => !guide.includes(`| \`${key}\` |`));
        expect(missingSettings, "settings missing from the agent guide").toEqual([]);

        for (const file of [KEYBINDINGS_LAST_GOOD_FILE, KEYBINDINGS_ERROR_FILE, "kept-terminals/"])
          expect(guide).toContain(`\`${file}\``);
      }).pipe(Effect.provide(server)),
    60_000,
  );

  it("lists a tool with its class, roles and input fields", () => {
    const [tool] = guideTools([
      {
        descriptor: { name: "example_tool", class: "crossThread", description: "Does a thing." },
        input: Schema.Struct({
          threadId: Schema.String.annotate({ description: "The thread to act on." }),
          note: Schema.optionalKey(Schema.String),
        }),
        audience: ["orchestrator"],
        handle: () => Effect.void,
      },
    ]);
    const guide = agentGuideText({ dataDir: "/data", tools: [tool!] });
    expect(guide).toContain(
      [
        "### `example_tool`",
        "",
        "Class: `crossThread` (acts on another thread; asks the user on a card, which they may remember for the session). Roles: orchestrator.",
        "",
        "Does a thing.",
        "",
        "Input:",
        "",
        "- `threadId` (required): The thread to act on.",
        "- `note`",
      ].join("\n"),
    );
    expect(guide).toContain("Written by Gram (a build from source) each time it starts");
  });
});
