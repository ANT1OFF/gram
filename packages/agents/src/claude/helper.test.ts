import { describe, expect, it } from "@effect/vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HelperTransportError } from "../helper.ts";
import { makeClaudeHelper, helperClaudeOptions } from "./helper.ts";
import type { ClaudeSdkShape } from "./sdk.ts";

const fixture = (env: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "gram-helper-protocol-"));
  const binary = join(root, "claude");
  const evidence = join(root, "evidence.jsonl");
  writeFileSync(
    binary,
    `#!${process.execPath}\n${readFileSync(new URL("../../fixtures/helpers/claude.cjs", import.meta.url), "utf8")}`,
  );
  chmodSync(binary, 0o755);
  writeFileSync(evidence, "");
  const prepared = {
    binaryPath: binary,
    sdkExecutable: binary,
    cliVersion: "2.1.296",
    warnings: [],
    env: {
      PATH: root,
      HOME: root,
      CLAUDE_CONFIG_DIR: root,
      GRAM_HELPER_EVIDENCE: evidence,
      ...env,
    },
  };
  const helper = makeClaudeHelper(
    { prepare: Effect.succeed(prepared), invalidate: Effect.void, checkAuth: () => Effect.void },
    { query } as ClaudeSdkShape,
  );
  return {
    root,
    helper,
    prepared,
    rows: () =>
      readFileSync(evidence, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s) as Record<string, unknown>),
  };
};
const call = {
  model: "haiku",
  speed: "standard" as const,
  effort: "high" as const,
  system: "Summarize fenced material as JSON.",
  prompt: "invented synthetic context",
  maxOutputTokens: 2000,
  authorize: (enqueue: () => void) => Effect.sync(enqueue),
};

describe("Claude isolated helper protocol", () => {
  it.effect(
    "discovers then runs one bounded tool-free Standard call without visible/history state",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        try {
          const models = yield* f.helper.models;
          expect(models[0]?.resolvedId).toBe("claude-haiku-5-5");
          expect(models[0]?.speeds).toEqual(["standard", "fast"]);
          expect(yield* f.helper.generate(call)).toEqual({
            text: '{"goal":"synthetic"}',
            usage: { inputTokens: 5, outputTokens: 3 },
          });
          const launches = f.rows().filter((r) => "tools" in r);
          expect(launches).toHaveLength(2);
          for (const row of launches) {
            expect(row).toMatchObject({
              tools: "",
              strict: true,
              persist: false,
              safe: true,
              outputCap: "2000",
              apiEnvironment: [],
              path: f.root,
            });
            expect(JSON.parse(String(row.settings))).toMatchObject({
              fastMode: false,
              fallbackModel: [],
              disableAllHooks: true,
              allowedMcpServers: [],
            });
            expect(existsSync(String(row.cwd))).toBe(false);
            if (row.model !== undefined)
              expect(row).toMatchObject({ model: "haiku", effort: "high" });
          }
          expect(f.rows().filter((r) => r.userSent)).toHaveLength(1);
          expect(readFileSync(join(f.root, "evidence.jsonl"), "utf8")).not.toContain(call.prompt);
        } finally {
          rmSync(f.root, { recursive: true, force: true });
        }
      }),
  );
  it.effect("refuses excluded MCP before sending context, and unavailable saved models", () =>
    Effect.gen(function* () {
      for (const [env, model, failure] of [
        [{ GRAM_HELPER_UNSAFE: "1" }, "haiku", "restriction"],
        [{ GRAM_HELPER_FAST: "1" }, "haiku", "restriction"],
        [{}, "withdrawn-haiku", "unavailable"],
      ] as const) {
        const f = fixture(env);
        try {
          expect(yield* f.helper.generate({ ...call, model }).pipe(Effect.flip)).toEqual(
            new HelperTransportError({ failure }),
          );
          expect(f.rows().some((r) => r.userSent)).toBe(false);
        } finally {
          rmSync(f.root, { recursive: true, force: true });
        }
      }
    }),
  );
  it.effect("refuses unsupported effort before sending context", () =>
    Effect.gen(function* () {
      const f = fixture();
      try {
        expect(yield* f.helper.generate({ ...call, effort: "max" }).pipe(Effect.flip)).toEqual(
          new HelperTransportError({ failure: "unavailable" }),
        );
        expect(f.rows().some((r) => r.userSent)).toBe(false);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    }),
  );
  it.effect(
    "refuses a CLI model substitution instead of accepting a differently generated answer",
    () =>
      Effect.gen(function* () {
        const f = fixture({ GRAM_HELPER_DIFFERENT_MODEL: "1" });
        try {
          expect(yield* f.helper.generate(call).pipe(Effect.flip)).toEqual(
            new HelperTransportError({ failure: "restriction" }),
          );
        } finally {
          rmSync(f.root, { recursive: true, force: true });
        }
      }),
  );
  it.effect("closes the helper process and scratch directory on cancellation", () =>
    Effect.gen(function* () {
      const f = fixture({ GRAM_HELPER_WAIT: "1" });
      try {
        const fiber = yield* Effect.forkScoped(f.helper.generate(call));
        // Await the synthetic protocol's own signal, with a bound; no provider is involved.
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              const started = Date.now();
              const check = () => {
                if (f.rows().some((r) => r.userSent)) resolve();
                else if (Date.now() - started > 5000)
                  reject(new Error("Fixture never received input"));
                else setTimeout(check, 5);
              };
              check();
            }),
        );
        yield* Fiber.interrupt(fiber);
        expect(existsSync(String(f.rows().find((r) => r.cwd)?.cwd))).toBe(false);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    }),
  );
  it("drops inherited model/body/debug overrides and locks settings", () => {
    const f = fixture({
      CLAUDE_CODE_EXTRA_BODY: "invented",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "expensive",
      DEBUG: "*",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
      MAX_THINKING_TOKENS: "0",
    });
    try {
      const options = helperClaudeOptions(f.prepared, "/synthetic");
      expect(options.env).not.toHaveProperty("CLAUDE_CODE_EXTRA_BODY");
      expect(options.env).not.toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL");
      expect(options.env).not.toHaveProperty("DEBUG");
      expect(options.env).not.toHaveProperty("CLAUDE_CODE_EFFORT_LEVEL");
      expect(options.env).not.toHaveProperty("MAX_THINKING_TOKENS");
      expect(options.tools).toEqual([]);
      expect(options.settingSources).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
