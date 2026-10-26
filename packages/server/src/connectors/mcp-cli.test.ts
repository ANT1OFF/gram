import { it as effectIt } from "@effect/vitest";
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  addJsonArgs,
  loginFailure,
  loginInvocation,
  McpCli,
  McpCliLive,
  redact,
  removeArgs,
  secretsOf,
} from "./mcp-cli.ts";

describe("claude mcp arguments", () => {
  it("passes the server as one JSON argument, under the scope asked for", () => {
    expect(
      addJsonArgs("sentry", "project", {
        type: "sse",
        url: "https://organization.example.invalid/sse",
        headers: { "X-Api-Key": "abcd" },
      }),
    ).toEqual([
      "mcp",
      "add-json",
      "--scope",
      "project",
      "sentry",
      '{"type":"sse","url":"https://organization.example.invalid/sse","headers":{"X-Api-Key":"abcd"}}',
    ]);
    expect(removeArgs("sentry", undefined)).toEqual(["mcp", "remove", "sentry"]);
    expect(removeArgs("sentry", "user")).toEqual(["mcp", "remove", "--scope", "user", "sentry"]);
  });

  it("masks env and header values in anything the CLI prints", () => {
    const config = {
      type: "stdio" as const,
      command: "run",
      env: { TOKEN: "sekrit-token", DEBUG: "1" },
    };
    expect(secretsOf(config)).toEqual(["sekrit-token"]);
    expect(redact("bad env TOKEN=sekrit-token (DEBUG=1)", secretsOf(config))).toBe(
      "bad env TOKEN=•••• (DEBUG=1)",
    );
  });

  it("runs claude mcp login under a terminal, and keeps only its own reason for failing", () => {
    expect(loginInvocation("example")).toEqual({
      bin: "/usr/bin/script",
      args: ["-q", "/dev/null", "claude", "mcp", "login", "example"],
    });
    const terminal =
      '\u0004\b\bStarting authentication for "x"…\r\nIf the browser didn\'t open, visit:\r\n' +
      "  \u001b]8;;https://idp.example/authorize?state=s3cr3t\u0007https://idp.example/authorize?state=s3cr3t\u001b]8;;\u0007\r\n" +
      '\u001b[0m\u001b[31mCouldn\'t complete authentication for "x": Error at https://idp.example/x?state=s3cr3t\u001b[0m';
    const reason = loginFailure({ status: 1, stdout: terminal, stderr: "" });
    expect(reason).toBe('Couldn\'t complete authentication for "x": Error at …');
    expect(loginFailure({ status: 2, stdout: "", stderr: "" })).toBe(
      "claude mcp login exited with code 2.",
    );
  });
});

// `GRAM_LIVE_MCP_LIST_URL=<an OAuth MCP server>`: the installed `claude` starts its sign-in to it
// with no thread, from a temp CLAUDE_CONFIG_DIR and with nobody at the keyboard. Its browser is a
// script that writes the page down, so nothing opens; the sign-in is then stopped, unfinished.
const listUrl = process.env["GRAM_LIVE_MCP_LIST_URL"];

describe.skipIf(listUrl === undefined || process.platform !== "darwin")(
  "claude mcp login, live (GRAM_LIVE_MCP_LIST_URL)",
  () => {
    effectIt.live(
      "starts Claude Code's own sign-in, with its loopback callback and the server's resource",
      () =>
        Effect.gen(function* () {
          const root = mkdtempSync(join(tmpdir(), "gram-claude-login-"));
          const config = join(root, "config");
          const project = join(root, "project");
          mkdirSync(config);
          mkdirSync(project);
          const opened = join(root, "opened.txt");
          const browser = join(root, "browser.sh");
          writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`);
          chmodSync(browser, 0o755);
          const saved = {
            config: process.env["CLAUDE_CONFIG_DIR"],
            browser: process.env["BROWSER"],
          };
          process.env["CLAUDE_CONFIG_DIR"] = config;
          process.env["BROWSER"] = browser;
          try {
            const name = "sb_live_login";
            const page = yield* Effect.gen(function* () {
              const cli = yield* McpCli;
              const added = yield* cli.run(
                ["mcp", "add", "--transport", "http", "--scope", "user", name, listUrl!],
                project,
              );
              expect(added.status).toBe(0);
              const login = yield* Effect.forkScoped(cli.login!(name, project));
              for (let i = 0; i < 60 && !existsSync(opened); i++) yield* Effect.sleep("500 millis");
              yield* Fiber.interrupt(login);
              return existsSync(opened) ? readFileSync(opened, "utf8").trim() : "";
            }).pipe(Effect.scoped, Effect.provide(McpCliLive.pipe(Layer.provide(ProcLive))));
            const url = new URL(page);
            expect(url.searchParams.get("redirect_uri")).toMatch(
              /^http:\/\/localhost:\d+\/callback$/,
            );
            expect(url.searchParams.get("code_challenge_method")).toBe("S256");
            expect(url.searchParams.get("resource")).toBe(listUrl);
            console.log(
              `claude: sign-in page on ${url.host}, client ${url.searchParams.get("client_id")}`,
            );
          } finally {
            for (const [key, value] of [
              ["CLAUDE_CONFIG_DIR", saved.config],
              ["BROWSER", saved.browser],
            ] as const) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
            rmSync(root, { recursive: true, force: true });
          }
        }),
      60_000,
    );
  },
);
