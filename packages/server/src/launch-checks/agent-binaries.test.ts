import { describe, expect, it } from "@effect/vitest";
import { CODEX_CLI_VERSION } from "@gram/agents/codex";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import { captureLogs } from "@gram/agents/testing/logs";
import { runLaunchChecks } from "./checks.ts";
import { pathLookup } from "./handler.ts";

const execFileAsync = promisify(execFile);

/** A fake CLI at `path` that prints `output` for `--version`. */
const fakeBinary = (path: string, output: string) => {
  writeFileSync(path, `#!/bin/sh\necho ${JSON.stringify(output)}\n`);
  chmodSync(path, 0o755);
};

describe.skipIf(process.platform === "win32")("launch checks over fake agent binaries", () => {
  it.live(
    "reads Codex versions, ignores retired executables with the tested version, and a stray install further down the PATH",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-agent-versions-"))),
        (dir) =>
          Effect.gen(function* () {
            const first = join(dir, "first");
            const second = join(dir, "second");
            mkdirSync(first);
            mkdirSync(second);
            fakeBinary(join(first, "codex"), "codex-cli 0.153.4");
            fakeBinary(join(second, "codex"), "0.153.3");

            // It logs what it found, which `checks.test.ts` asserts; a warning would be news.
            const checks = yield* runLaunchChecks({
              path: Effect.succeed(`${first}:${second}`),
              ...pathLookup,
              claudeUnusable: () => Effect.succeed(undefined),
              run: (file, args) =>
                Effect.tryPromise(() => execFileAsync(file, [...args])).pipe(
                  Effect.map(({ stdout }) => ({ status: 0, stdout })),
                ),
              now: () => 1,
            }).pipe(Effect.provide(captureLogs({ printWarnings: true }).layer));
            const byTool = new Map(checks.tools.map((tool) => [tool.tool, tool]));

            expect(byTool.get("codex")).toEqual({
              tool: "codex",
              found: true,
              path: join(first, "codex"),
              version: "0.153.4",
              testedVersion: CODEX_CLI_VERSION,
              upgradeCommand: `npm i -g @openai/codex@${CODEX_CLI_VERSION}`,
              shadowed: [{ path: join(second, "codex"), version: "0.153.3" }],
            });
            expect(byTool.get("claude")).toEqual({ tool: "claude", found: false });
          }),
        (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      ),
    30_000,
  );
});
