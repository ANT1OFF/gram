import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Invented login shell and only-Codex PATH; no provider/credential/global config access. */
export const codexHelperFixture = (extra: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "gram-codex-helper-test-"));
  const binaryPath = join(root, "codex");
  const shell = join(root, "login-shell");
  const evidence = join(root, "evidence.jsonl");
  const env = {
    HOME: root,
    CODEX_HOME: root,
    PATH: root,
    GRAM_HELPER_EVIDENCE: evidence,
    ...extra,
  };
  writeFileSync(evidence, "");
  writeFileSync(
    binaryPath,
    `#!${process.execPath}\n${readFileSync(new URL("../../fixtures/helpers/codex.cjs", import.meta.url), "utf8")}`,
  );
  writeFileSync(
    shell,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(
      `\0__SB_PROBE__\0${binaryPath}\0__SB_ENV__\0${Object.entries(env)
        .map(([key, value]) => `${key}=${value}\0`)
        .join("")}`,
    )});`,
  );
  chmodSync(binaryPath, 0o755);
  chmodSync(shell, 0o755);
  return {
    root,
    config: { binaryPath, shell },
    rows: () =>
      readFileSync(evidence, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};
