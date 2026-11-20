import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type { ApprovalRequest, GitState, Project, Thread } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach } from "vitest";

import type { AppToolDefinition } from "../app-tools/definition.ts";
import {
  localCheckRunFor,
  runIdOf,
  type LocalCheck,
  type LocalCheckRun,
} from "../git/local-checks.ts";
import { driverRun, verifyTools } from "./verify-tools.ts";

const THREAD = "t-verify" as Thread["id"];
const PROJECT = "p-verify" as Project["id"];
const HEAD = "a".repeat(40);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const repoWith = (drivers: unknown) => {
  const root = mkdtempSync(join(tmpdir(), "gram-verify-"));
  roots.push(root);
  mkdirSync(join(root, ".gram"));
  writeFileSync(join(root, ".gram", "verify.json"), JSON.stringify({ drivers }));
  return root;
};

const harness = (
  root: string,
  answers: Array<"allow" | "deny">,
  trust: Project["folderTrust"] = "trusted",
) => {
  const cards: Omit<ApprovalRequest, "kind" | "id">[] = [];
  const runs: LocalCheckRun[] = [];
  const tools = verifyTools({
    store: {
      getThread: () =>
        Effect.succeed({
          id: THREAD,
          role: "worker",
          projectId: PROJECT,
          checkout: { kind: "worktree", path: root },
        } as unknown as Thread),
      listProjects: Effect.succeed([
        { id: PROJECT, root, name: "repo", bookmarked: false, folderTrust: trust } as Project,
      ]),
    },
    runtimes: {
      requestApproval: (_threadId, request) =>
        Effect.sync(() => {
          cards.push(request);
          return { kind: "approval", decision: answers.shift() ?? "deny", scope: "once" } as const;
        }),
      sendNotice: () => Effect.succeed({} as never),
    },
    publisher: {
      refresh: () => Effect.void,
      stateFor: () =>
        Effect.succeed({ repo: true, head: HEAD, changedFiles: 0 } as unknown as GitState),
    },
    checks: {
      lookup: () => Effect.succeed(undefined),
      ensure: (_site, head, base, options) =>
        Effect.sync(() => {
          runs.push(options.run!);
          return {
            head,
            base,
            tree: "",
            status: "running",
            command: options.run!.command,
            isolation: options.run!.isolation,
            startedAt: 0,
            host: "here",
          } satisfies LocalCheck;
        }),
    },
    hosts: undefined,
    proc: Effect.succeed(Option.none()),
  });
  const call = (input: unknown) => {
    const tool = tools[0] as AppToolDefinition;
    return Schema.decodeUnknownEffect(tool.input as Schema.Codec<unknown, unknown>)(input).pipe(
      Effect.orDie,
      Effect.flatMap((decoded) => tool.handle(THREAD, decoded, {})),
    );
  };
  return { call, cards, runs };
};

describe("verify", () => {
  it.effect("asks once per command before Gram runs it, and again when the command changes", () =>
    Effect.gen(function* () {
      const root = repoWith([{ name: "unit", run: "bun run test" }]);
      const { call, cards, runs } = harness(root, ["deny", "allow", "allow"]);

      const declined = yield* Effect.flip(call({ driver: "unit" }));
      expect(declined).toMatchObject({ approvalRequired: true });
      expect(runs).toEqual([]);

      yield* call({ driver: "unit" });
      yield* call({ driver: "unit" });
      expect(cards).toHaveLength(2);
      expect(runs.map((run) => run.command)).toEqual(["bun run test", "bun run test"]);

      writeFileSync(
        join(root, ".gram", "verify.json"),
        JSON.stringify({ drivers: [{ name: "unit", run: "true" }] }),
      );
      yield* call({ driver: "unit" });
      expect(cards).toHaveLength(3);
      expect(cards[2]?.description).toContain("runs true");
    }),
  );

  it.effect("runs nothing in a folder the user hasn't trusted", () =>
    Effect.gen(function* () {
      const root = repoWith([{ name: "unit", run: "bun run test" }]);
      const { call, cards, runs } = harness(root, ["allow"], "untrusted");
      const refused = yield* Effect.flip(call({ driver: "unit" }));
      expect(refused.message).toContain("hasn't trusted");
      expect(cards).toEqual([]);
      expect(runs).toEqual([]);
    }),
  );

  it.effect("has nothing to run without a recipe, and says why a broken one can't be read", () =>
    Effect.gen(function* () {
      const bare = mkdtempSync(join(tmpdir(), "gram-verify-"));
      roots.push(bare);
      expect(yield* harness(bare, []).call({})).toMatchObject({ drivers: [] });
      const broken = repoWith([{ name: "unit" }]);
      const refused = yield* Effect.flip(harness(broken, []).call({}));
      expect(refused.message).toContain('needs a "name" and a "run"');
    }),
  );
});

describe("a driver's run", () => {
  it("never keys as the project's merge check, even with the same command", () => {
    const command = "bun run check";
    const merge = localCheckRunFor({ command }, PROJECT)!;
    expect(runIdOf(driverRun({ name: "check", run: command }, PROJECT))).not.toBe(runIdOf(merge));
  });
});
