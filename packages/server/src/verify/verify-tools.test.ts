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
import { evidenceDirOf } from "../git/check-evidence.ts";
import {
  localCheckRunFor,
  runIdOf,
  type LocalCheck,
  type LocalCheckRun,
} from "../git/local-checks.ts";
import {
  driverRun,
  requiredOnHead,
  verifyProfile,
  verifyEvidenceOf,
  verifyStateOf,
  verifyTools,
} from "./verify-tools.ts";

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
  passed: ReadonlySet<string> = new Set(),
  /** More of a passed run's record, by its profile: its log, the machine it ran on. */
  more: Record<string, Partial<LocalCheck>> = {},
) => {
  const cards: Omit<ApprovalRequest, "kind" | "id">[] = [];
  const runs: LocalCheckRun[] = [];
  const deps = {
    store: {
      getThread: (_id: Thread["id"]) =>
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
      lookup: (
        _site: unknown,
        head: string | undefined,
        _base: unknown,
        _project: unknown,
        run?: LocalCheckRun,
      ) =>
        Effect.succeed(
          run !== undefined && head !== undefined && passed.has(run.profile ?? "")
            ? ({
                head,
                base: head,
                tree: "",
                status: "passed",
                command: run.command,
                isolation: run.isolation,
                startedAt: 0,
                host: "here",
                ...more[run.profile ?? ""],
              } satisfies LocalCheck)
            : undefined,
        ),
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
  } satisfies Parameters<typeof verifyTools>[0];
  const tools = verifyTools(deps);
  const call = (input: unknown) => {
    const tool = tools[0] as AppToolDefinition;
    return Schema.decodeUnknownEffect(tool.input as Schema.Codec<unknown, unknown>)(input).pipe(
      Effect.orDie,
      Effect.flatMap((decoded) => tool.handle(THREAD, decoded, {})),
    );
  };
  const state = () =>
    Effect.flatMap(deps.store.getThread(THREAD), (thread) => verifyStateOf(deps, thread));
  const evidence = (driver: string, file: string) =>
    Effect.flatMap(deps.store.getThread(THREAD), (thread) =>
      verifyEvidenceOf(deps, thread, driver, file),
    );
  return { call, cards, runs, required: () => requiredOnHead(deps, THREAD), state, evidence };
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

describe("required drivers on a worker's head", () => {
  it.effect("names those without a pass, and nothing when the recipe requires none", () =>
    Effect.gen(function* () {
      const root = repoWith([
        { name: "unit", run: "t", required: true },
        { name: "shots", run: "s", required: true },
        { name: "lint", run: "l" },
      ]);
      const passedUnit = new Set([verifyProfile({ name: "unit" })]);
      expect(yield* harness(root, [], "trusted", passedUnit).required()).toEqual({
        head: HEAD,
        passed: ["unit"],
        missing: ["shots"],
      });
      const optional = repoWith([{ name: "lint", run: "l" }]);
      expect(yield* harness(optional, []).required()).toBeUndefined();
    }),
  );
});

describe("the Proof tab's state", () => {
  it.effect(
    "is Gram's record per driver on the head, and says when there's no recipe or a broken one",
    () =>
      Effect.gen(function* () {
        const root = repoWith([
          { name: "unit", run: "t", required: true },
          { name: "lint", run: "l", kind: "lint" },
        ]);
        const passedUnit = new Set([verifyProfile({ name: "unit" })]);
        expect(yield* harness(root, [], "trusted", passedUnit).state()).toEqual({
          recipe: "ok",
          head: HEAD,
          drivers: [
            { name: "unit", run: "t", required: true, status: "passed", startedAt: 0 },
            { name: "lint", run: "l", kind: "lint", status: "notRun" },
          ],
        });
        const bare = mkdtempSync(join(tmpdir(), "gram-verify-"));
        roots.push(bare);
        expect(yield* harness(bare, []).state()).toEqual({ recipe: "none", drivers: [] });
        expect(yield* harness(repoWith([{ name: "unit" }]), []).state()).toMatchObject({
          recipe: "unreadable",
          error: expect.stringContaining('needs a "name" and a "run"'),
        });
      }),
  );
});

describe("a driver's evidence", () => {
  it.effect("shows what its run on the head kept, and only on this machine", () =>
    Effect.gen(function* () {
      const root = repoWith([
        { name: "flow", run: "f" },
        { name: "far", run: "r" },
      ]);
      const log = join(root, "flow.log");
      mkdirSync(evidenceDirOf(log));
      writeFileSync(join(evidenceDirOf(log), "shot.png"), "png");
      const far = join(root, "far.log");
      mkdirSync(evidenceDirOf(far));
      writeFileSync(join(evidenceDirOf(far), "shot.png"), "png");
      const flow = verifyProfile({ name: "flow" });
      const remote = verifyProfile({ name: "far" });
      const run = harness(root, [], "trusted", new Set([flow, remote]), {
        [flow]: { log },
        [remote]: { log: far, machine: "joined" },
      });
      const [shown, elsewhere] = (yield* run.state()).drivers;
      expect(shown?.evidence).toEqual([{ file: "shot.png", kind: "screenshot", size: 3 }]);
      expect(elsewhere).not.toHaveProperty("evidence");
      expect(yield* run.evidence("flow", "shot.png")).toMatchObject({ base64: "cG5n" });
      expect(yield* run.evidence("far", "shot.png")).toBeUndefined();
      expect(yield* run.evidence("missing", "shot.png")).toBeUndefined();
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
