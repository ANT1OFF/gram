import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listeningUrl, openCodeEnv, SERVER_SECRETS, withShell, wrapperScript } from "./server.ts";
import { GATEWAY_KEY_ENV } from "./session.ts";

describe("opencode serve's environment", () => {
  it("drops debuggers, preloads, request logs, Anthropic logins and a parent's secrets", () => {
    const env = openCodeEnv({
      PATH: "/bin",
      HOME: "/home/u",
      HTTPS_PROXY: "http://proxy:1",
      NODE_OPTIONS: "--inspect",
      SSLKEYLOGFILE: "/tmp/keys",
      LD_PRELOAD: "x.so",
      DEBUG: "*",
      ANTHROPIC_API_KEY: "sk-ant-test",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      OPENCODE_SERVER_PASSWORD: "parent",
      OPENCODE_CONFIG_CONTENT: "{}",
      [GATEWAY_KEY_ENV]: "old",
      OPENAI_API_KEY: "sk-test",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/u",
      HTTPS_PROXY: "http://proxy:1",
      OPENAI_API_KEY: "sk-test",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    });
    expect(SERVER_SECRETS).toContain(GATEWAY_KEY_ENV);
  });

  it("sets the tools' shell in the inline config, keeping the rest", () => {
    expect(JSON.parse(withShell('{"model":"gram/m"}', "/w/shell"))).toEqual({
      model: "gram/m",
      shell: "/w/shell",
    });
    expect(JSON.parse(withShell(undefined, "/w/shell"))).toEqual({ shell: "/w/shell" });
  });

  it.skipIf(process.platform === "win32")(
    "starts the tools' shell without the server's secrets",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "oc-wrapper-test-"));
      try {
        const path = join(dir, "shell");
        writeFileSync(path, wrapperScript("/bin/sh"), { mode: 0o700 });
        const out = execFileSync(path, ["-c", "env"], {
          env: {
            PATH: "/usr/bin:/bin",
            KEPT: "yes",
            OPENCODE_SERVER_PASSWORD: "pw-test",
            OPENCODE_CONFIG_CONTENT: '{"providers":{}}',
            [GATEWAY_KEY_ENV]: "key-test",
          },
          encoding: "utf8",
        });
        expect(out).toContain("KEPT=yes");
        expect(out).not.toContain("pw-test");
        expect(out).not.toContain("key-test");
        expect(out).not.toContain("OPENCODE_CONFIG_CONTENT");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("reads where the server listens", () => {
    expect(listeningUrl("server listening on http://127.0.0.1:4096\n")).toBe(
      "http://127.0.0.1:4096",
    );
    expect(listeningUrl("server listening on http://0.0.0.0:4096")).toBeUndefined();
  });
});
