import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { CATALOG_DIR } from "@gram/agents/codex";
import * as Effect from "effect/Effect";
import { parse as parseToml } from "smol-toml";

import {
  codexGatewayInheritance,
  codexModelFor,
  codexModelIn,
  codexSkillRoots,
  INHERITED_FILE,
  installOutwardRules,
  OUTWARD_PROMPT_RULES,
  OUTWARD_RULES_FILE,
  outwardPromptRules,
  prepareCodexHome,
  releaseCodexHome,
  removeOutwardRules,
  syncCodexInstructions,
} from "./codex-home.ts";

const USER_CONFIG = `model_provider = "corp"

[model_providers.corp]
name = "Corp gateway"
base_url = "https://gateway.example/v1"
env_key = "LLM_API_KEY"

[mcp_servers.docs]
command = "npx"
args = ["docs-mcp"]
`;

describe("prepareCodexHome", () => {
  it.effect("writes only the user's MCP servers into Gram's own Codex home", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "gram-codex-home-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(root, { recursive: true, force: true })),
      );
      const home = join(root, "home");
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), USER_CONFIG);

      const target = yield* prepareCodexHome(join(root, "data"), home, {});
      expect(target).toBe(join(root, "data", "codex-home"));
      const written = readFileSync(join(target, "config.toml"), "utf8");
      expect(parseToml(written)).toEqual({
        mcp_servers: { docs: { command: "npx", args: ["docs-mcp"] } },
      });
      expect(written).not.toContain("gateway.example");
      expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(USER_CONFIG);

      // `CODEX_HOME` names the user's home when set; without a config the owned one stays empty.
      const empty = yield* prepareCodexHome(join(root, "data-2"), home, {
        CODEX_HOME: join(root, "missing"),
      });
      expect(readFileSync(join(empty, "config.toml"), "utf8")).toBe("");
    }).pipe(Effect.scoped),
  );

  it.effect("leaves out a user entry named like our app-tools server", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "gram-codex-home-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(root, { recursive: true, force: true })),
      );
      const home = join(root, "home");
      mkdirSync(join(home, ".codex"), { recursive: true });
      const fixture = readFileSync(
        new URL("./fixtures/codex-config-gram-entry.toml", import.meta.url),
        "utf8",
      );
      writeFileSync(join(home, ".codex", "config.toml"), fixture);

      const target = yield* prepareCodexHome(join(root, "data"), home, {});
      const written = readFileSync(join(target, "config.toml"), "utf8");
      expect(parseToml(written)).toEqual({
        mcp_servers: { docs: { command: "npx", args: ["docs-mcp"] } },
      });
      expect(written).not.toContain("old-gram");

      // Only our entry: nothing is left to write.
      writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.gram]\ncommand = "node"\n');
      const onlyOurs = yield* prepareCodexHome(join(root, "data-2"), home, {});
      expect(readFileSync(join(onlyOurs, "config.toml"), "utf8")).toBe("");
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(process.platform === "win32")(
    "keeps the copy private to the user, and removes it and the model catalogs on release",
    () =>
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "gram-codex-home-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(root, { recursive: true, force: true })),
        );
        const home = join(root, "home");
        mkdirSync(join(home, ".codex"), { recursive: true });
        writeFileSync(join(home, ".codex", "config.toml"), USER_CONFIG);
        const dataDir = join(root, "data");
        // A home left over with loose permissions is tightened on the next start.
        mkdirSync(join(dataDir, "codex-home"), { recursive: true, mode: 0o755 });

        const target = yield* prepareCodexHome(dataDir, home, {});
        expect(statSync(target).mode & 0o777).toBe(0o700);
        expect(statSync(join(target, "config.toml")).mode & 0o777).toBe(0o600);

        mkdirSync(join(target, CATALOG_DIR));
        writeFileSync(join(target, CATALOG_DIR, "example.json"), "{}");

        yield* releaseCodexHome(dataDir);
        expect(existsSync(join(target, "config.toml"))).toBe(false);
        expect(existsSync(join(target, CATALOG_DIR))).toBe(false);
        expect(existsSync(target)).toBe(true);
        // Releasing again, with nothing left to remove, is fine.
        yield* releaseCodexHome(dataDir);
      }).pipe(Effect.scoped),
  );

  it.effect("removes shell snapshots an earlier Codex left with the gateway key in them", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "gram-codex-home-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(root, { recursive: true, force: true })),
      );
      const dataDir = join(root, "data");
      const snapshots = join(dataDir, "codex-home", "shell_snapshots");
      mkdirSync(snapshots, { recursive: true });
      writeFileSync(join(snapshots, "old.sh"), "export LLM_API_KEY=sk-stale-sentinel\n");
      mkdirSync(join(dataDir, "codex-home", "sessions"), { recursive: true });

      const target = yield* prepareCodexHome(dataDir, join(root, "home"), {});
      expect(existsSync(join(target, "shell_snapshots"))).toBe(false);
      // Past gateway sessions stay resumable.
      expect(existsSync(join(target, "sessions"))).toBe(true);
    }).pipe(Effect.scoped),
  );
});

describe("what the gateway home inherits", () => {
  it.effect("copies the user's skill settings, never their hooks, notify, trust or rules", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "gram-codex-home-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(root, { recursive: true, force: true })),
      );
      const home = join(root, "home");
      mkdirSync(join(home, ".codex", "rules"), { recursive: true });
      writeFileSync(
        join(home, ".codex", "rules", "default.rules"),
        'prefix_rule(pattern=["git"], decision="allow")\n',
      );
      writeFileSync(join(home, ".codex", "auth.json"), '{"sentinel":"sk-auth-sentinel"}');
      writeFileSync(
        join(home, ".codex", "config.toml"),
        `notify = ["say", "done"]
${USER_CONFIG}
[projects."/repo"]
trust_level = "trusted"

[hooks]
on_start = "touch /tmp/x"

[[skills.config]]
path = "/home/.codex/skills/old/SKILL.md"
enabled = false
`,
      );

      const target = yield* prepareCodexHome(join(root, "data"), home, {});
      expect(parseToml(readFileSync(join(target, "config.toml"), "utf8"))).toEqual({
        mcp_servers: { docs: { command: "npx", args: ["docs-mcp"] } },
        skills: { config: [{ path: "/home/.codex/skills/old/SKILL.md", enabled: false }] },
      });
      expect(readdirSync(target).toSorted()).toEqual(["config.toml", INHERITED_FILE]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "copies the instructions Codex would read, follows changes, and drops them when gone",
    () =>
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "gram-codex-home-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(root, { recursive: true, force: true })),
        );
        const home = join(root, "home");
        const userHome = join(home, ".codex");
        mkdirSync(userHome, { recursive: true });
        const dataDir = join(root, "data");
        const target = join(dataDir, "codex-home");
        const copied = () => readFileSync(join(target, "AGENTS.md"), "utf8");
        const source = () =>
          (
            JSON.parse(readFileSync(join(target, INHERITED_FILE), "utf8")) as {
              instructions: string;
            }
          ).instructions;

        writeFileSync(join(userHome, "AGENTS.md"), "Use pnpm.\n");
        yield* prepareCodexHome(dataDir, home, {});
        expect(copied()).toBe("Use pnpm.\n");
        expect(source()).toBe(join(userHome, "AGENTS.md"));

        // A blank override is skipped, as Codex skips it; a real one wins.
        writeFileSync(join(userHome, "AGENTS.override.md"), "  \n");
        expect(yield* syncCodexInstructions(dataDir, home, {})).toBe(join(userHome, "AGENTS.md"));
        writeFileSync(join(userHome, "AGENTS.override.md"), "Use bun.\n");
        yield* syncCodexInstructions(dataDir, home, {});
        expect(copied()).toBe("Use bun.\n");
        expect(source()).toBe(join(userHome, "AGENTS.override.md"));
        expect(existsSync(join(target, "AGENTS.override.md"))).toBe(false);

        rmSync(join(userHome, "AGENTS.override.md"));
        rmSync(join(userHome, "AGENTS.md"));
        expect(yield* syncCodexInstructions(dataDir, home, {})).toBeUndefined();
        expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
        expect(yield* codexGatewayInheritance(dataDir)).toEqual({ skills: [] });

        // `CODEX_HOME` names the user's home, and release takes the copy out but keeps the record.
        const custom = join(root, "custom");
        mkdirSync(custom);
        writeFileSync(join(custom, "AGENTS.md"), "Custom.\n");
        yield* prepareCodexHome(dataDir, home, { CODEX_HOME: custom });
        expect(copied()).toBe("Custom.\n");
        yield* releaseCodexHome(dataDir);
        expect(existsSync(join(target, "AGENTS.md"))).toBe(false);
        expect(yield* codexGatewayInheritance(dataDir)).toEqual({
          skills: [],
          instructions: join(custom, "AGENTS.md"),
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "records the skill folders from the user's env, and gives only CODEX_HOME's as a root",
    () =>
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "gram-codex-home-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(root, { recursive: true, force: true })),
        );
        const dataDir = join(root, "data");
        const home = join(root, "home");
        expect(yield* codexSkillRoots(home, {})).toEqual([]);
        expect(yield* codexGatewayInheritance(dataDir)).toEqual({ skills: [] });

        // `CODEX_HOME` set in the login shell names the user's home, not `~/.codex`.
        const custom = join(root, "custom");
        mkdirSync(join(custom, "skills"), { recursive: true });
        mkdirSync(join(home, ".codex", "skills"), { recursive: true });
        mkdirSync(join(home, ".agents", "skills"), { recursive: true });
        writeFileSync(join(custom, "AGENTS.md"), "Hi.\n");
        const env = { HOME: home, CODEX_HOME: custom };
        expect(yield* codexSkillRoots(home, env)).toEqual([join(custom, "skills")]);
        yield* prepareCodexHome(dataDir, home, env);
        expect(yield* codexGatewayInheritance(dataDir)).toEqual({
          skills: [join(home, ".agents", "skills"), join(custom, "skills")],
          instructions: join(custom, "AGENTS.md"),
        });
      }).pipe(Effect.scoped),
  );
});

describe("the outward gate's Codex rules", () => {
  it("asks about the ordinary ways to push and publish, in Codex's rules syntax", () => {
    const rules = OUTWARD_PROMPT_RULES.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    expect(rules.map((rule) => rule.replace(/, justification=".*"\)$/, ")"))).toEqual([
      'prefix_rule(pattern=["git", "push"], decision="prompt")',
      'prefix_rule(pattern=["git", "subtree", "push"], decision="prompt")',
      'prefix_rule(pattern=["gh", "pr", ["create", "new", "merge", "close"]], decision="prompt")',
      'prefix_rule(pattern=["gh", "release", ["create", "new"]], decision="prompt")',
      'prefix_rule(pattern=["gh", "workflow", "run"], decision="prompt")',
      'prefix_rule(pattern=["gh", "repo", "delete"], decision="prompt")',
    ]);
    // An allow would be the hole itself, and a forbid would stop a push the user said yes to.
    expect(OUTWARD_PROMPT_RULES).not.toMatch(/decision="(allow|forbidden)"/);
  });

  it("at irreversible, still catch every push, and leave a new PR to the thread's policy", () => {
    const rules = outwardPromptRules("irreversible");
    const patterns = rules
      .split("\n")
      .filter((l) => l !== "" && !l.startsWith("#"))
      .map((rule) => rule.replace(/, justification=".*"\)$/, ")"));
    // The push rules stay: an "always allow" on `git push` would otherwise run `git push origin
    // +main` unasked, and the adapter answers the ordinary pushes itself.
    expect(patterns).toEqual([
      'prefix_rule(pattern=["git", "push"], decision="prompt")',
      'prefix_rule(pattern=["git", "subtree", "push"], decision="prompt")',
      'prefix_rule(pattern=["gh", "pr", ["merge", "close"]], decision="prompt")',
      'prefix_rule(pattern=["gh", "release", ["create", "new"]], decision="prompt")',
      'prefix_rule(pattern=["gh", "workflow", "run"], decision="prompt")',
      'prefix_rule(pattern=["gh", "repo", "delete"], decision="prompt")',
    ]);
    expect(rules).not.toMatch(/\["gh", "pr", \[[^\]]*"(create|new)"/);
    expect(rules).not.toMatch(/decision="(allow|forbidden)"/);
    expect(outwardPromptRules("all")).toBe(OUTWARD_PROMPT_RULES);
  });

  it.effect(
    "go into Gram's home only while asked for, private to the user, and never the user's own",
    () =>
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "gram-codex-home-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(root, { recursive: true, force: true })),
        );
        const home = join(root, "home");
        mkdirSync(join(home, ".codex", "rules"), { recursive: true });
        writeFileSync(join(home, ".codex", "config.toml"), USER_CONFIG);
        const dataDir = join(root, "data");
        const target = yield* prepareCodexHome(dataDir, home, {});
        const file = join(target, "rules", OUTWARD_RULES_FILE);
        // Not there by default: under an ungated session's `never` policy it would reject a push.
        expect(existsSync(file)).toBe(false);

        // Codex's own rules, where an "always allow" lands, are left alone throughout.
        mkdirSync(join(target, "rules"), { recursive: true });
        const own = join(target, "rules", "default.rules");
        writeFileSync(own, 'prefix_rule(pattern=["npm", "test"], decision="allow")\n');

        yield* installOutwardRules(dataDir);
        expect(readFileSync(file, "utf8")).toBe(OUTWARD_PROMPT_RULES);
        if (process.platform !== "win32") {
          expect(statSync(file).mode & 0o777).toBe(0o600);
          expect(statSync(join(target, "rules")).mode & 0o777).toBe(0o700);
        }
        yield* removeOutwardRules(dataDir);
        expect(existsSync(file)).toBe(false);
        yield* removeOutwardRules(dataDir);

        // Each install replaces what is there, so one level's rules never outlive its own open.
        yield* installOutwardRules(dataDir, "irreversible");
        expect(readFileSync(file, "utf8")).toBe(outwardPromptRules("irreversible"));
        yield* installOutwardRules(dataDir, "all");
        expect(readFileSync(file, "utf8")).toBe(OUTWARD_PROMPT_RULES);
        yield* installOutwardRules(dataDir, "irreversible");
        expect(readFileSync(file, "utf8")).toBe(outwardPromptRules("irreversible"));
        yield* removeOutwardRules(dataDir);
        expect(existsSync(file)).toBe(false);

        // One a crash left behind goes when the home is next prepared, or released.
        yield* installOutwardRules(dataDir);
        yield* prepareCodexHome(dataDir, home, {});
        expect(existsSync(file)).toBe(false);
        yield* installOutwardRules(dataDir);
        yield* releaseCodexHome(dataDir);
        expect(existsSync(file)).toBe(false);

        expect(existsSync(own)).toBe(true);
        expect(readdirSync(join(home, ".codex", "rules"))).toEqual([]);
      }).pipe(Effect.scoped),
  );
});

describe("codexModelIn", () => {
  const config = {
    model: "gpt-6-astra",
    model_provider: "example",
    model_providers: {
      example: { base_url: "https://gateway.example.invalid/v1", env_key: "LLM_API_KEY" },
      other: { base_url: "https://other.example/v1" },
    },
    profiles: { quick: { model_provider: "other", model: "o-mini" } },
  };

  it("takes the active provider's model when its base URL matches, ignoring case and slashes", () => {
    expect(codexModelIn(config, "https://GATEWAY.example.invalid/v1/")).toBe("gpt-6-astra");
  });

  it("falls back to a profile on a matching provider, and names nothing without a match", () => {
    expect(codexModelIn(config, "https://other.example/v1")).toBe("o-mini");
    expect(codexModelIn(config, "https://unknown.example/v1")).toBeUndefined();
    expect(codexModelIn({ model: "gpt-6-astra" }, "https://llm.example/v1")).toBeUndefined();
    expect(codexModelIn(undefined, "https://llm.example/v1")).toBeUndefined();
  });

  it.effect("reads the user's config.toml, and nothing when there's none", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "gram-codex-model-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(root, { recursive: true, force: true })),
      );
      const home = join(root, "home");
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".codex", "config.toml"), USER_CONFIG_WITH_MODEL);
      const before = readFileSync(join(home, ".codex", "config.toml"), "utf8");

      expect(yield* codexModelFor(home, {})("https://gateway.example/v1")).toBe("gpt-6-astra");
      expect(yield* codexModelFor(join(root, "nobody"), {})("https://gateway.example/v1")).toBe(
        undefined,
      );
      // Only read, never written.
      expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(before);
    }).pipe(Effect.scoped),
  );
});

const USER_CONFIG_WITH_MODEL = `model = "gpt-6-astra"
model_provider = "corp"

[model_providers.corp]
name = "Corp gateway"
base_url = "https://gateway.example/v1"
env_key = "LLM_API_KEY"
`;
