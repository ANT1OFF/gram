// What each role costs before it reads a word of its task: its system prompt and the definitions
// of the Gram tools its sessions are bound with, spent on the user's subscription at every open.
// Each limit sits about 5% over the size measured when it was set, so neither grows without
// anyone deciding it should. Lower a limit when its text shrinks; raise one only on purpose, in
// the change that needs the room, and say so there.
import { describe, expect, it } from "@effect/vitest";
import { type AgentKind, type Autonomy, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { hasGit } from "../git/test-repo.ts";
import { plainPrompt, rolePrompt, workerPrompt } from "./prompt.ts";
import { makeWorld, withServer } from "./test-harness.ts";

type Role = "orchestrator" | "worker" | "plain";
const ROLES: ReadonlyArray<Role> = ["orchestrator", "worker", "plain"];

/**
 * Characters, prompt and tools together. Measured on 2026-11-02 at 59,373, 33,022 and 22,669.
 * Characters rather than tokens: no tokenizer is a dependency, and the ratio moves little. Worker
 * and plain raised by 1,000 on 2026-11-03 for the `ciStuck` and `machine` wake conditions, which
 * every role's `schedule_wake` lists (measured then at 61,307, 35,201 and 24,370).
 */
const BUDGET: Readonly<Record<Role, number>> = {
  orchestrator: 62_400,
  worker: 35_700,
  plain: 24_900,
};

const AUTONOMIES: ReadonlyArray<Autonomy> = ["supervised", "publish", "full"];
const AGENTS: ReadonlyArray<AgentKind> = ["claude", "codex"];

/** A role's system prompt for synthetic names, at one level and harness. */
const promptOf = (role: Role, autonomy: Autonomy, agent: AgentKind): string => {
  switch (role) {
    case "orchestrator":
      return rolePrompt({
        workspaceName: "Shop",
        projects: [
          { name: "shop", root: "/work/shop", home: true },
          { name: "warehouse", root: "/work/warehouse", home: false },
        ],
        autonomy,
        agent,
        gated: true,
      });
    case "worker":
      return workerPrompt({
        feature: "mail-trigger",
        orchestratorTitle: "Orchestrator · Shop",
        alsoIn: [
          { project: "warehouse", path: "/work/warehouse-mail", branch: "feat/mail-trigger" },
        ],
        autonomy,
        agent,
        gated: true,
      });
    case "plain":
      return plainPrompt({ agent }) ?? "";
  }
};

/** The longest system prompt a role gets, over every level and harness. */
const longestPrompt = (role: Role): number =>
  Math.max(
    ...AUTONOMIES.flatMap((autonomy) =>
      AGENTS.map((agent) => promptOf(role, autonomy, agent).length),
    ),
  );

describe.skipIf(!hasGit)("prompt size budget", () => {
  it.effect("keeps each role's system prompt and tool definitions within its limit", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const registry = yield* AppToolRegistry;
          for (const role of ROLES) {
            // What a session lists of each tool: its name, description and input schema.
            const tools = registry
              .forThread("caller" as ThreadId, role)
              .reduce(
                (sum, tool) =>
                  sum +
                  tool.descriptor.name.length +
                  tool.descriptor.description.length +
                  JSON.stringify(Schema.toJsonSchemaDocument(tool.input).schema).length,
                0,
              );
            const prompt = longestPrompt(role);
            expect(
              prompt + tools,
              `${role}: prompt ${prompt} + tools ${tools} characters, over its limit of ${BUDGET[role]}`,
            ).toBeLessThanOrEqual(BUDGET[role]);
          }
        }),
      );
    }),
  );
});
