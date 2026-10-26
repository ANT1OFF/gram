import { describe, expect, it } from "@effect/vitest";
import {
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { parse } from "smol-toml";
import {
  installOutwardRules,
  OUTWARD_RULES_FILE,
  outwardPromptRules,
  removeOutwardRules,
} from "./codex-home.ts";
import { prepareOwnedCodexHome } from "./codex-owned-home.ts";

const fixture = Effect.gen(function* () {
  const root = mkdtempSync(join(tmpdir(), "gram-native-home-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(root, { recursive: true, force: true })),
  );
  const user = join(root, "custom-codex");
  mkdirSync(join(user, "rules"), { recursive: true });
  writeFileSync(join(user, "auth.json"), "invented login fixture");
  writeFileSync(
    join(user, "rules", "allow.rules"),
    'prefix_rule(pattern=["git", "push"], decision="allow")',
  );
  return { root, user, data: join(root, "data"), env: { CODEX_HOME: user } };
});

describe("Gram-owned native Codex home", () => {
  it.effect(
    "links auth by path, shares refreshes and never imports rules or permission/provider overrides",
    () =>
      Effect.gen(function* () {
        const { root, user, data, env } = yield* fixture;
        const config = `model = "gpt-6"
approval_policy = "never"
approvals_reviewer = "auto_review"
sandbox_mode = "danger-full-access"
model_provider = "custom"
profile = "unsafe"
notify = ["sh", "unsafe"]
cli_auth_credentials_store = "keyring"
[features]
exec_policy = false
hooks = true
[profiles.unsafe]
approval_policy = "never"
[model_providers.custom]
base_url = "https://example.invalid"
[mcp_servers.docs]
command = "docs"
[mcp_servers.gram]
command = "shadow"
[skills]
bundled = false
`;
        writeFileSync(join(user, "config.toml"), config);
        const target = yield* prepareOwnedCodexHome(data, root, env);
        const link = join(target, "auth.json");
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readlinkSync(link)).toBe(join(user, "auth.json"));
        expect(statSync(link).ino).toBe(statSync(join(user, "auth.json")).ino);
        // Invented token refreshes in either direction use the same file, with no Gram auth reads.
        writeFileSync(link, "invented CLI refresh");
        expect(readFileSync(join(user, "auth.json"), "utf8")).toBe("invented CLI refresh");
        writeFileSync(join(user, "auth.json"), "invented native refresh");
        expect(readFileSync(link, "utf8")).toBe("invented native refresh");
        expect(readdirSync(target).toSorted()).toEqual(["auth.json", "config.toml"]);
        const written = parse(readFileSync(join(target, "config.toml"), "utf8"));
        expect(written).toMatchObject({
          model: "gpt-6",
          model_provider: "openai",
          forced_login_method: "chatgpt",
          cli_auth_credentials_store: "file",
          features: {
            exec_policy: true,
            hooks: false,
            plugins: false,
            apps: false,
            shell_snapshot: false,
          },
          mcp_servers: { docs: { command: "docs" } },
          skills: { bundled: false },
        });
        for (const key of [
          "profiles",
          "profile",
          "model_providers",
          "notify",
          "approvals_reviewer",
          "approval_policy",
          "sandbox_mode",
        ])
          expect(written).not.toHaveProperty(key);
        expect(written["mcp_servers"]).not.toHaveProperty("gram");
        for (const level of ["all", "irreversible"] as const) {
          yield* installOutwardRules(data, level, "owned");
          expect(readFileSync(join(target, "rules", OUTWARD_RULES_FILE), "utf8")).toBe(
            outwardPromptRules(level),
          );
        }
        expect(readFileSync(join(user, "config.toml"), "utf8")).toBe(config);
        expect(readdirSync(join(user, "rules"))).toEqual(["allow.rules"]);
        if (process.platform !== "win32") {
          expect(statSync(target).mode & 0o777).toBe(0o700);
          expect(statSync(join(target, "config.toml")).mode & 0o777).toBe(0o600);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "removes obsolete policy defaults from an existing owned home without native auth",
    () =>
      Effect.gen(function* () {
        const { root, user, data, env } = yield* fixture;
        const target = join(data, "codex-owned-home");
        mkdirSync(target, { recursive: true });
        writeFileSync(
          join(target, "config.toml"),
          'approval_policy = "untrusted"\nsandbox_mode = "workspace-write"\n',
        );
        rmSync(join(user, "auth.json"));
        expect(yield* prepareOwnedCodexHome(data, root, env, false)).toBe(target);
        const written = parse(readFileSync(join(target, "config.toml"), "utf8"));
        expect(written).not.toHaveProperty("approval_policy");
        expect(written).not.toHaveProperty("sandbox_mode");
        expect(written).toHaveProperty("forced_login_method", "chatgpt");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "allows keyless history after logout, clears stale prompt rules and refuses aliases of the native home",
    () =>
      Effect.gen(function* () {
        const { root, user, data, env } = yield* fixture;
        const target = yield* prepareOwnedCodexHome(data, root, env);
        yield* installOutwardRules(data, "all", "owned");
        rmSync(join(user, "auth.json"));
        expect(Exit.isFailure(yield* Effect.exit(prepareOwnedCodexHome(data, root, env)))).toBe(
          true,
        );
        yield* prepareOwnedCodexHome(data, root, env, false);
        expect(lstatSync(join(target, "auth.json")).isSymbolicLink()).toBe(true);
        expect(readdirSync(join(target, "rules"))).toEqual([]);
        // A source alias of the target must never turn a real auth file into a self-referencing link.
        rmSync(join(target, "auth.json"));
        writeFileSync(join(target, "auth.json"), "invented auth stays");
        const alias = join(root, "alias");
        symlinkSync(target, alias, "dir");
        expect(
          Exit.isFailure(
            yield* Effect.exit(prepareOwnedCodexHome(data, root, { CODEX_HOME: alias })),
          ),
        ).toBe(true);
        expect(lstatSync(join(target, "auth.json")).isSymbolicLink()).toBe(false);
        expect(readFileSync(join(target, "auth.json"), "utf8")).toBe("invented auth stays");
      }).pipe(Effect.scoped),
  );

  for (const alias of ["home", "rules"] as const) {
    it.effect(`preserves native rules when failed preparation cleans up a symlinked ${alias}`, () =>
      Effect.gen(function* () {
        const { root, user, data, env } = yield* fixture;
        const nativeRule = join(user, "rules", OUTWARD_RULES_FILE);
        writeFileSync(nativeRule, "invented native rule must stay");
        const target = join(data, "codex-owned-home");
        mkdirSync(alias === "home" ? data : target, { recursive: true });
        symlinkSync(
          alias === "home" ? user : join(user, "rules"),
          alias === "home" ? target : join(target, "rules"),
          "dir",
        );
        const ready = yield* prepareOwnedCodexHome(data, root, env).pipe(
          Effect.ensuring(removeOutwardRules(data, "owned")),
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        );
        expect(ready).toBe(false);
        expect(readFileSync(nativeRule, "utf8")).toBe("invented native rule must stay");
        expect(Exit.isFailure(yield* Effect.exit(installOutwardRules(data, "all", "owned")))).toBe(
          true,
        );
        expect(readFileSync(nativeRule, "utf8")).toBe("invented native rule must stay");
      }).pipe(Effect.scoped),
    );
  }

  it.effect("rejects hardlinked config and prompt-rule files before any rewrite or chmod", () =>
    Effect.gen(function* () {
      const { root, user, data, env } = yield* fixture;
      const config = 'model = "native-config-stays"';
      writeFileSync(join(user, "config.toml"), config);
      const target = yield* prepareOwnedCodexHome(data, root, env);
      rmSync(join(target, "config.toml"));
      linkSync(join(user, "config.toml"), join(target, "config.toml"));
      expect(Exit.isFailure(yield* Effect.exit(prepareOwnedCodexHome(data, root, env)))).toBe(true);
      expect(readFileSync(join(user, "config.toml"), "utf8")).toBe(config);
      mkdirSync(join(target, "rules"));
      const nativeRule = join(user, "rules", OUTWARD_RULES_FILE);
      writeFileSync(nativeRule, "invented rule stays");
      linkSync(nativeRule, join(target, "rules", OUTWARD_RULES_FILE));
      expect(Exit.isFailure(yield* Effect.exit(installOutwardRules(data, "all", "owned")))).toBe(
        true,
      );
      expect(readFileSync(nativeRule, "utf8")).toBe("invented rule stays");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fails closed for missing auth, invalid config and symlinked writable paths without echoing values",
    () =>
      Effect.gen(function* () {
        const { root, user, data, env } = yield* fixture;
        const prepare = prepareOwnedCodexHome(data, root, env);
        rmSync(join(user, "auth.json"));
        expect(Exit.isFailure(yield* Effect.exit(prepare))).toBe(true);
        writeFileSync(join(user, "auth.json"), "invented login");
        writeFileSync(join(user, "config.toml"), 'model = "private-invalid-value');
        const invalid = yield* Effect.exit(prepare);
        expect(Exit.isFailure(invalid)).toBe(true);
        expect(JSON.stringify(invalid)).not.toContain("private-invalid-value");
        writeFileSync(join(user, "config.toml"), 'model = "gpt-6"');
        const target = yield* prepare;
        rmSync(join(target, "config.toml"));
        symlinkSync(join(user, "config.toml"), join(target, "config.toml"));
        expect(Exit.isFailure(yield* Effect.exit(prepare))).toBe(true);
        expect(readFileSync(join(user, "config.toml"), "utf8")).toBe('model = "gpt-6"');
      }).pipe(Effect.scoped),
  );
});
