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
 * Characters rather than tokens: no tokenizer is a dependency, and the ratio moves little. Raised
 * on 2026-11-03 for the `ciStuck`, `machine`, `freezeLifted`, `releasePublished` and
 * `versionChanged` wake conditions and `merge_freeze` (measured last at 62,853, 36,747 and 25,071),
 * then trimmed the same day back under the sizes measured before condition wakes (59,504, 33,500
 * and 22,669): `schedule_wake` lists its condition flat (`WakeConditionInput`), and prompts and
 * tool descriptions lost their repeats. Measured then at 58,957, 33,497 and 22,649; each limit
 * sits about 4% over. The worker's raised on 2026-11-05, on purpose, for two worker tools that
 * routines and workspace memory need (#198 with #199 merged in): `memory_list` and `memory_read`,
 * read-only, with the prompt's line on when to look; and `routine_create`, whose call from a worker
 * always asks the user. Its description was cut first; measured then at 35,470, about 4% under it.
 * The orchestrator's raised on 2026-11-09, on purpose, for `spawn_worker`'s `machine` (a worker
 * on a joined machine), its line cut to one sentence first. Raised again on 2026-11-09, on purpose,
 * for two routing lines (check for a live owner before spawning; start on the likeliest reading),
 * with the duplicate `title` line cut first; measured then at 61,747.
 */
const BUDGET: Readonly<Record<Role, number>> = {
  orchestrator: 61_800,
  worker: 36_900,
  plain: 23_550,
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
