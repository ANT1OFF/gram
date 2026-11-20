import { describe, expect, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { parse } from "smol-toml";
import { prepareOwnedGrokHome } from "./grok-owned-home.ts";

/** A person's home with Claude Code settings that allow every command and add an MCP server. */
const personHome = () => {
  const root = mkdtempSync(join(tmpdir(), "gram-grok-home-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(*)", "Edit"] } }),
  );
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { personal: { command: "personal-mcp", args: [] } } }),
  );
  const work = join(root, "work");
  mkdirSync(work);
  return { root, home, work, data: join(root, "data") };
};

const grok = process.env["GROK_BIN"] ?? "grok";
const hasGrok = spawnSync(grok, ["--version"], { encoding: "utf8" }).status === 0;

/** What `grok inspect` finds in `work` when started with `env`. */
const inspect = (env: Record<string, string>, work: string) => {
  const run = spawnSync(grok, ["inspect", "--json"], {
    cwd: work,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return JSON.parse(run.stdout) as {
    permissions: { loaded: number; sources: string[] };
    mcpServers: unknown[];
  };
};

describe("Gram's own Grok Build home", () => {
  it.effect("shares only the login file, by path, and switches off the other vendors", () =>
    Effect.gen(function* () {
      const { root, home, data } = personHome();
      try {
        const env = yield* prepareOwnedGrokHome(data, home, {
          HOME: home,
          PATH: "/usr/bin",
          GROK_CONFIG: '{"compat":{"claude":{"mcps":true}}}',
          GROK_CONFIG_PATH: join(home, "overlay.toml"),
          GROK_CLAUDE_MCPS_ENABLED: "1",
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
        });
        const owned = join(data, "grok-owned-home");
        expect(env["HOME"]).toBe(owned);
        expect(env["GROK_HOME"]).toBe(join(owned, ".grok"));
        expect(env["PATH"]).toBe("/usr/bin");
        for (const name of [
          "GROK_CONFIG",
          "GROK_CONFIG_PATH",
          "GROK_CLAUDE_MCPS_ENABLED",
          "CLAUDE_CONFIG_DIR",
        ])
          expect(env, name).not.toHaveProperty(name);
        expect(readlinkSync(join(owned, ".grok", "auth.json"))).toBe(
          join(home, ".grok", "auth.json"),
        );
        const config = parse(readFileSync(join(owned, ".grok", "config.toml"), "utf8"));
        expect(config["compat"]).toMatchObject({
          claude: { skills: false, rules: false, agents: false, mcps: false, hooks: false },
          cursor: { skills: false, rules: false, agents: false, mcps: false, hooks: false },
        });
        expect(config["shell_environment_policy"]).toEqual({
          set: { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") },
        });
        expect(statSync(owned).mode & 0o777).toBe(0o700);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("refuses to run in the person's own Grok home", () =>
    Effect.gen(function* () {
      const { root, home } = personHome();
      try {
        const exit = yield* Effect.exit(
          prepareOwnedGrokHome(join(home, ".grok", ".."), home, {
            HOME: home,
            GROK_HOME: join(home, "grok-owned-home", ".grok"),
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect.skipIf(!hasGrok)(
    "keeps the person's Claude Code allow rules and MCP servers from Grok Build",
    () =>
      Effect.gen(function* () {
        const { root, home, work, data } = personHome();
        try {
          const base = { PATH: process.env["PATH"] ?? "/usr/bin", HOME: home };
          const unowned = inspect({ ...base, GROK_HOME: join(home, ".grok") }, work);
          expect(unowned.permissions.loaded).toBeGreaterThan(0);
          expect(unowned.mcpServers.length).toBeGreaterThan(0);
          const owned = inspect(yield* prepareOwnedGrokHome(data, home, base), work);
          expect(owned.permissions).toMatchObject({ loaded: 0, sources: [] });
          expect(owned.mcpServers).toEqual([]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }),
    120_000,
  );
});
