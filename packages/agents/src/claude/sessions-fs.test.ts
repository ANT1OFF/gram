import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { ClaudeEnvironment } from "./environment.ts";
import { ClaudeSdkLive } from "./sdk-live.ts";
import { ClaudeHost, ClaudeHostLayer } from "./session.ts";

// The SDK's session listing and delete over a temp CLAUDE_CONFIG_DIR, never the real ~/.claude.
let root: string;
let previousConfigDir: string | undefined;

/**
 * Writes a two-line transcript where the SDK keeps `projectDir`'s sessions: the projects folder
 * named by the SDK's rule, every character outside `[a-zA-Z0-9]` as `-`. `projectDir` must be the
 * native real path the SDK resolves `dir` to.
 */
const writeSession = (projectDir: string, sessionId: string, prompt: string) => {
  const slug = projectDir.replace(/[^a-zA-Z0-9]/g, "-");
  // The SDK hashes names past 200 characters; temp paths stay short of that.
  expect(slug.length).toBeLessThanOrEqual(200);
  const dir = join(root, "config", "projects", slug);
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const lines = [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId,
      cwd: projectDir,
      timestamp: at,
      message: { role: "user", content: prompt },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId,
      cwd: projectDir,
      timestamp: at,
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    },
  ];
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
};

const layer = ClaudeHostLayer().pipe(
  Layer.provide(
    Layer.merge(
      ClaudeSdkLive,
      Layer.succeed(ClaudeEnvironment)({
        prepare: Effect.die("no sessions are opened here"),
        invalidate: Effect.void,
        checkAuth: () => Effect.void,
      }),
    ),
  ),
);

beforeAll(() => {
  // Native, like the SDK's own resolve: long names on Windows (not `RUNNER~1`), `/private` on macOS.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "gram-claude-sessions-")));
  previousConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  process.env["CLAUDE_CONFIG_DIR"] = join(root, "config");
});

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = previousConfigDir;
  // A timed-out test can't cancel the SDK's reads, and Windows won't remove a folder they hold open.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("ClaudeHost session history", () => {
  it.effect(
    "lists a folder's sessions and deletes only those it lists",
    () =>
      Effect.gen(function* () {
        const repo = join(root, "repo");
        const other = join(root, "other");
        mkdirSync(repo);
        mkdirSync(other);
        const mine = writeSession(
          repo,
          "11111111-2222-4333-8444-555555555555",
          "Fix the retry test",
        );
        const theirs = writeSession(other, "99999999-2222-4333-8444-555555555555", "Other project");

        const host = yield* ClaudeHost;
        if (host.listSessions === undefined || host.deleteSession === undefined) {
          throw new Error("the live SDK lists and deletes sessions");
        }
        expect(yield* host.listSessions({ cwd: repo })).toMatchObject([
          { agentSessionId: "11111111-2222-4333-8444-555555555555", title: "Fix the retry test" },
        ]);

        const error = yield* Effect.flip(
          host.deleteSession({ cwd: repo, agentSessionId: "99999999-2222-4333-8444-555555555555" }),
        );
        expect(error).toMatchObject({ _tag: "NotFound", entity: "session" });
        expect(existsSync(theirs)).toBe(true);

        yield* host.deleteSession({
          cwd: repo,
          agentSessionId: "11111111-2222-4333-8444-555555555555",
        });
        expect(existsSync(mine)).toBe(false);
        expect(yield* host.listSessions({ cwd: repo })).toEqual([]);
        expect(yield* host.listSessions({ cwd: other })).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
    // Usually about a second on Windows CI, but a loaded runner has taken past 5 s.
    60_000,
  );
});
