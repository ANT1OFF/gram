import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { diagnoseExit, lastLines, missingCommand, spawnCheck } from "./check-process.ts";
import { LOCAL_CHECK_ISOLATION } from "./local-checks.ts";
import { removeDir, tempDir, write } from "./test-repo.ts";

const LAUNCHD_PATH = "/usr/bin:/bin";

describe.skipIf(process.platform === "win32")("the configured local check", () => {
  it.live("runs setup then command on login-shell PATH without a Bun pin check", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      const bin = nodePath.join(dir, "login-bin");
      mkdirSync(bin);
      const tool = nodePath.join(bin, "invented-check");
      write(
        tool,
        '#!/bin/sh\necho "check PATH=$PATH CI=${CI-unset} GRAM=${GRAM_STATE_DIR-unset} GITDIR=${GIT_DIR-unset} SSH=${GIT_SSH_COMMAND-unset}"\ntest -f setup.txt\n',
      );
      chmodSync(tool, 0o755);
      write(nodePath.join(dir, ".bun-version"), "unavailable-bun\n");
      const log = nodePath.join(dir, "check.log");
      const pathValue = `${bin}:${LAUNCHD_PATH}`;
      const environment = {
        base: {
          PATH: LAUNCHD_PATH,
          CI: "1",
          GRAM_STATE_DIR: "/invented",
          GIT_DIR: "/invented/other.git",
          GIT_SSH_COMMAND: "ssh -x",
        },
        pathValue,
      };
      expect(
        yield* spawnCheck(dir, log, environment, {
          isolation: LOCAL_CHECK_ISOLATION,
          setup: "touch setup.txt",
          command: "invented-check",
          timeoutMs: 1000,
        }),
      ).toEqual({ ok: true });
      expect(readFileSync(log, "utf8")).toContain(`check PATH=${pathValue} CI=unset GRAM=unset`);
      expect(readFileSync(log, "utf8")).toContain("GITDIR=unset SSH=ssh -x");
      expect(
        yield* spawnCheck(dir, log, environment, {
          isolation: LOCAL_CHECK_ISOLATION,
          setup: "exit 4",
          command: "echo should-not-run",
          timeoutMs: 1000,
        }),
      ).toMatchObject({ ok: false, reason: "exited 4", failure: { kind: "exited", exitCode: 4 } });
      expect(readFileSync(log, "utf8")).not.toContain("should-not-run");
      expect(
        yield* spawnCheck(dir, log, environment, {
          isolation: LOCAL_CHECK_ISOLATION,
          command: "exit 3",
          timeoutMs: 1000,
        }),
      ).toMatchObject({ ok: false, reason: "exited 3", failure: { kind: "exited", exitCode: 3 } });
      removeDir(dir);
    }),
  );
  it.live("keeps setup shell syntax separate from the required command", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      const log = nodePath.join(dir, "check.log");
      const environment = { base: { PATH: LAUNCHD_PATH }, pathValue: LAUNCHD_PATH };
      const result = yield* spawnCheck(dir, log, environment, {
        isolation: LOCAL_CHECK_ISOLATION,
        setup: "true); exit 0; (true",
        command: "echo RAN; exit 1",
        timeoutMs: 1000,
      });
      expect(result.ok).toBe(false);
      expect(readFileSync(log, "utf8")).not.toContain("RAN");
      // A setup can exit successfully, but that never returns a pass for the command.
      expect(
        yield* spawnCheck(dir, log, environment, {
          isolation: LOCAL_CHECK_ISOLATION,
          setup: "echo SETUP; exit 0",
          command: "echo RAN; exit 1",
          timeoutMs: 1000,
        }),
      ).toMatchObject({ ok: false, failure: { exitCode: 1 } });
      expect(readFileSync(log, "utf8")).toMatch(/^SETUP\nRAN\n.*command.*exit 1/i);
      // Shell comments in either independently valid value retain their normal meaning.
      expect(
        yield* spawnCheck(dir, log, environment, {
          isolation: LOCAL_CHECK_ISOLATION,
          setup: "echo SETUP # install dependencies",
          command: "echo RAN # run tests",
          timeoutMs: 1000,
        }),
      ).toEqual({ ok: true });
      expect(readFileSync(log, "utf8")).toBe("SETUP\nRAN\n");
      removeDir(dir);
    }),
  );
  it.live("runs Gram's former sequence only when its owner explicitly configures it", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      const bin = nodePath.join(dir, "bin");
      mkdirSync(bin);
      const bun = nodePath.join(bin, "bun");
      write(
        bun,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo invented-pin; exit 0; fi\necho "bun $*"\n',
      );
      write(nodePath.join(dir, ".bun-version"), "invented-pin\n");
      chmodSync(bun, 0o755);
      const log = nodePath.join(dir, "check.log");
      expect(
        yield* spawnCheck(
          dir,
          log,
          { base: { PATH: LAUNCHD_PATH }, pathValue: `${bin}:${LAUNCHD_PATH}` },
          {
            isolation: LOCAL_CHECK_ISOLATION,
            command: "bun install --frozen-lockfile && bun run check:ci",
            setup: 'test "$(bun --version)" = "$(cat .bun-version)"',
            timeoutMs: 5_400_000,
          },
        ),
      ).toEqual({ ok: true });
      expect(readFileSync(log, "utf8")).toBe("bun install --frozen-lockfile\nbun run check:ci\n");
      write(nodePath.join(dir, ".bun-version"), "newer-pin\n");
      const failed = yield* spawnCheck(
        dir,
        log,
        { base: { PATH: LAUNCHD_PATH }, pathValue: `${bin}:${LAUNCHD_PATH}` },
        {
          isolation: LOCAL_CHECK_ISOLATION,
          command: "echo should-not-run",
          setup: 'test "$(bun --version)" = "$(cat .bun-version)"',
        },
      );
      expect(failed).toMatchObject({ ok: false, failure: { kind: "exited", exitCode: 1 } });
      const output = readFileSync(log, "utf8");
      expect(output).toMatch(/setup.*exit 1/i);
      expect(output).not.toContain("should-not-run");
      removeDir(dir);
    }),
  );
  it.live("shares one timeout across separate setup and command processes", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      const result = yield* spawnCheck(
        dir,
        nodePath.join(dir, "check.log"),
        {
          base: { PATH: LAUNCHD_PATH },
          pathValue: LAUNCHD_PATH,
        },
        {
          isolation: LOCAL_CHECK_ISOLATION,
          // Each step alone fits the budget; the two together don't.
          setup: "sleep 0.6",
          command: "sleep 0.6; touch finished",
          timeoutMs: 1_000,
        },
      );
      expect(result).toMatchObject({
        ok: false,
        reason: "timed out: still running after 1000 ms, so Gram stopped it",
      });
      expect(existsSync(nodePath.join(dir, "finished"))).toBe(false);
      removeDir(dir);
    }),
  );
  it.live("enforces the configured timeout", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      expect(
        yield* spawnCheck(
          dir,
          nodePath.join(dir, "check.log"),
          { base: { PATH: LAUNCHD_PATH }, pathValue: LAUNCHD_PATH },
          {
            isolation: LOCAL_CHECK_ISOLATION,
            command: "trap 'echo timeout-cleanup >&2' TERM; sleep 5; :",
            timeoutMs: 20,
          },
        ),
      ).toEqual({
        ok: false,
        reason: "timed out: still running after 20 ms, so Gram stopped it",
        failure: { kind: "timed-out" },
      });
      removeDir(dir);
    }),
  );
});

describe("why a local check failed", () => {
  it("names the command a shell or env couldn't find", () => {
    expect(missingCommand("/bin/sh: line 1: tsc: command not found")).toBe("tsc");
    expect(missingCommand("sh: tsc: command not found")).toBe("tsc");
    expect(missingCommand("/bin/sh: 1: node: not found")).toBe("node");
    expect(missingCommand("zsh: command not found: cargo")).toBe("cargo");
    expect(missingCommand("env: node: No such file or directory")).toBe("node");
    expect(missingCommand("/usr/bin/env: ‘python3’: No such file or directory")).toBe("python3");
    // The last one named is the one that stopped it.
    expect(missingCommand("sh: a: command not found\nok\nsh: b: command not found\n")).toBe("b");
    expect(missingCommand("FAIL src/x.test.ts\n1 failed")).toBeUndefined();
    // A script bash runs names itself by its path.
    expect(missingCommand("./scripts/build.sh: line 3: tsc: command not found")).toBe("tsc");
    expect(missingCommand("/tmp/x/bin/bun: 2: gram-test-missing-tool: not found")).toBe(
      "gram-test-missing-tool",
    );
    expect(missingCommand("bun: command not found: vite")).toBe("vite");
    // Only a shell's or env's own line counts, coloured or not.
    expect(missingCommand("\u001b[31msh: line 1: tsc: command not found\u001b[0m")).toBe("tsc");
    expect(missingCommand("Error: command not found")).toBeUndefined();
    expect(missingCommand("  expected: command not found: foo")).toBeUndefined();
  });

  it("explains each kind of exit", () => {
    expect(diagnoseExit(0, null, "", "/usr/bin")).toEqual({ ok: true });
    expect(
      diagnoseExit(127, null, "sh: line 1: tsc: command not found\n", "/usr/bin:/bin"),
    ).toEqual({
      ok: false,
      reason:
        "`tsc` was not found on the check's PATH (exit 127); install it or add its folder to PATH in your shell profile, then restart Gram. PATH=/usr/bin:/bin",
      failure: {
        kind: "not-found",
        command: "tsc",
        path: "/usr/bin:/bin",
        exitCode: 127,
        tail: "sh: line 1: tsc: command not found",
      },
    });
    expect(diagnoseExit(127, null, "", "/usr/bin").reason).toMatch(/^a command was not found/);
    expect(diagnoseExit(1, null, "\u001b[31mFAIL\u001b[0m a.test.ts\n\n 2 failed\n", "/p")).toEqual(
      {
        ok: false,
        reason: "exited 1",
        failure: { kind: "exited", exitCode: 1, tail: "FAIL a.test.ts\n 2 failed" },
      },
    );
    expect(diagnoseExit(null, "SIGKILL", "", "/p")).toEqual({
      ok: false,
      reason: "stopped by SIGKILL",
      failure: { kind: "stopped" },
    });
    expect(lastLines(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), 3)).toBe(
      "line 37\nline 38\nline 39",
    );
    // Progress overwritten in place, a window title and stray control characters: plain lines.
    expect(lastLines("10%\r50%\r100%\n\u001b]0;title\u0007done\u0008\n")).toBe("100%\ndone");
    // The check runs with the server's environment: what a test prints of it is redacted.
    const token = `ghp_${"a".repeat(36)}`;
    const leaked = diagnoseExit(1, null, `env dump\nGH_TOKEN=${token}\nAPI_KEY=hunter22\n`, "/p");
    expect(JSON.stringify(leaked)).not.toContain(token);
    expect(JSON.stringify(leaked)).not.toContain("hunter22");
    expect(leaked.failure?.tail).toContain("[redacted]");
  });
});
