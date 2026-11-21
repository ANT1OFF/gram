import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadId } from "@gram/contracts";
import {
  AntigravityHost,
  AntigravityHostLive,
  CUSTOMIZATIONS_REFUSAL,
} from "@gram/agents/antigravity";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  antigravityGeminiDir,
  ownedAntigravitySettings,
  prepareOwnedAntigravityHome,
} from "./antigravity-owned-home.ts";

/**
 * A person's home whose Antigravity settings allow every command without asking, and whose MCP
 * config starts a server that leaves a mark when it runs.
 */
const personHome = () => {
  const root = mkdtempSync(join(tmpdir(), "gram-agy-home-"));
  const home = join(root, "home");
  const marker = join(root, "personal-mcp-ran");
  const own = join(root, "session-mcp-ran");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  writeFileSync(
    join(home, ".gemini", "antigravity-cli", "settings.json"),
    JSON.stringify({ toolPermission: "always-proceed", permissions: { allow: ["command(*)"] } }),
  );
  writeFileSync(
    join(home, ".gemini", "config", "mcp_config.json"),
    JSON.stringify({
      mcpServers: { personal: { command: "sh", args: ["-c", `touch '${marker}'; sleep 30`] } },
    }),
  );
  const work = join(root, "work");
  mkdirSync(work);
  return { root, home, work, marker, own, data: join(root, "data") };
};

const agy = process.env["AGY_BIN"] ?? "agy";
const agyProbe = spawnSync(agy, ["--version"], { encoding: "utf8" });
const hasAgy = agyProbe.status === 0;
const agyVersion = (agyProbe.stdout ?? "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
const agyPremiseSkip = (() => {
  if (!hasAgy) return "agy is unavailable";
  if (agyVersion === null) return "could not parse agy --version (requires agy 1.5.13 or newer)";
  const major = Number(agyVersion[1]);
  const minor = Number(agyVersion[2]);
  const patch = Number(agyVersion[3]);
  if (major > 1 || (major === 1 && (minor > 5 || (minor === 5 && patch >= 13)))) return undefined;
  return `requires agy 1.5.13 or newer, found ${agyVersion[0]}`;
})();
/** Also run a turn on the model, which spends the signed-in plan's quota. */
const live = hasAgy && process.env["GRAM_LIVE_AGY"] === "1";

interface Run {
  readonly asked: boolean;
  readonly output: string;
  readonly stop: () => Promise<void>;
}

/** An MCP server of the session's own, as Gram passes its app tools, that marks when it starts. */
const sessionServer = (marker: string) => ({
  name: "gram",
  command: "sh",
  args: ["-c", `touch '${marker}'; sleep 30`],
  env: [],
});

/**
 * Opens a session on `agy acp` with `env` and `args`, waits for its MCP servers to start, and
 * runs `prompt` in Default mode when given, allowing what it asks. Says whether it asked, and what
 * its commands printed.
 */
const acp = (
  env: Record<string, string>,
  args: ReadonlyArray<string>,
  cwd: string,
  server: ReturnType<typeof sessionServer>,
  prompt?: string,
): Promise<Run> =>
  new Promise((resolve, reject) => {
    const child = spawn(agy, ["acp", ...args], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    let buffer = "";
    let asked = false;
    let output = "";
    let next = 0;
    const waiting = new Map<number, (result: Record<string, unknown>) => void>();
    const send = (message: Record<string, unknown>) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((done) => {
        const id = ++next;
        waiting.set(id, done);
        send({ id, method, params });
      });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      buffer += data;
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const params = (message["params"] ?? {}) as Record<string, unknown>;
        if (message["method"] === "session/request_permission") {
          asked = true;
          send({
            id: message["id"],
            result: { outcome: { outcome: "selected", optionId: "allow" } },
          });
        } else if (message["method"] === "session/update") {
          output += JSON.stringify(
            (params["update"] as Record<string, unknown>)["rawOutput"] ?? "",
          );
        } else if (typeof message["id"] === "number") {
          waiting.get(message["id"])?.((message["result"] ?? {}) as Record<string, unknown>);
        }
      }
    });
    child.once("error", reject);
    void (async () => {
      await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
      if (env["GEMINI_API_KEY"] !== undefined)
        await call("authenticate", { methodId: "gemini-api-key" });
      const opened = await call("session/new", { cwd, mcpServers: [server] });
      const sessionId = opened["sessionId"];
      if (prompt !== undefined) {
        await call("session/set_config_option", {
          sessionId,
          configId: "model",
          value: "gemini-3.8-flash",
        });
        await call("session/set_mode", { sessionId, modeId: "default" });
        await call("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
      }
      resolve({
        asked,
        output,
        stop: () => {
          child.kill("SIGTERM");
          return closed;
        },
      });
    })().catch(reject);
  });

/**
 * A repository's own `.agents` hooks and MCP server, each leaving a mark when it runs, in `work`.
 */
const repoCustomizations = (root: string, work: string) => {
  const hook = join(root, "repo-hook-ran");
  const server = join(root, "repo-mcp-ran");
  mkdirSync(join(work, ".agents"));
  writeFileSync(
    join(work, ".agents", "hooks.json"),
    JSON.stringify({ marker: { SessionStart: [{ type: "command", command: `touch '${hook}'` }] } }),
  );
  writeFileSync(
    join(work, ".agents", "mcp_config.json"),
    JSON.stringify({
      mcpServers: { repo: { command: "sh", args: ["-c", `touch '${server}'; sleep 30`] } },
    }),
  );
  return { hook, server };
};

/** A Gemini API stand-in on loopback that answers every request 404, so no turn reaches Google. */
const standIn = () =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ url: string; close: () => void }>((done) => {
          const server = createServer((_request, response) => {
            response.statusCode = 404;
            response.end("{}");
          });
          server.listen(0, "127.0.0.1", () =>
            done({
              url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
              close: () => server.close(),
            }),
          );
        }),
    ),
    (server) => Effect.sync(server.close),
  );

const localGeminiEnv = (home: string, url: string) => ({
  PATH: process.env["PATH"] ?? "/usr/bin",
  HOME: home,
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
  GEMINI_API_KEY: "placeholder",
  GOOGLE_GEMINI_BASE_URL: url,
});

const repoWorkspaces = [
  {
    name: "a work folder with its own hooks and MCP servers",
    skipReason: hasAgy ? undefined : "agy is unavailable",
    place: (root: string, work: string) => ({ cwd: work, marks: repoCustomizations(root, work) }),
  },
  {
    name: "a linked work folder whose real repository has hooks and MCP servers",
    skipReason: agyPremiseSkip,
    place: (root: string, work: string) => {
      const repo = join(root, "repo");
      mkdirSync(join(repo, "sub"), { recursive: true });
      spawnSync("git", ["init", "-q", repo], {
        env: {
          PATH: process.env["PATH"],
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      const lnk = join(work, "lnk");
      symlinkSync(join(repo, "sub"), lnk);
      return { cwd: lnk, marks: repoCustomizations(root, repo) };
    },
  },
];

type PlaceCustomizations = (typeof repoWorkspaces)[number]["place"];

/** Gram must refuse the workspace before looking for or starting an executable. */
const refuseRepoCustomizations = (place: PlaceCustomizations) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { root, home, work, data } = personHome();
      try {
        const { cwd, marks } = place(root, work);
        const geminiDir = antigravityGeminiDir(data);
        const host = yield* Effect.provide(
          Effect.gen(function* () {
            return yield* AntigravityHost;
          }),
          AntigravityHostLive({
            ownedHome: () => prepareOwnedAntigravityHome(data, home, { HOME: home }),
            geminiDir,
            binaryPath: join(root, "unavailable-agy"),
          }),
        );
        const opened = yield* Effect.flip(
          Effect.scoped(
            host.open({
              threadId: ThreadId.make("t"),
              cwd,
              permissionMode: "bypassPermissions",
            }),
          ),
        );
        expect(opened.message).toContain(CUSTOMIZATIONS_REFUSAL);
        const listed = yield* Effect.flip(host.listSessions?.({ cwd }) ?? Effect.die("no listing"));
        expect(listed.message).toContain(CUSTOMIZATIONS_REFUSAL);
        expect(existsSync(geminiDir)).toBe(false);
        expect(existsSync(marks.hook)).toBe(false);
        expect(existsSync(marks.server)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

/** Show that plain `agy acp` runs the customizations even with Gram's owned home. */
const agyRunsRepoCustomizations = (place: PlaceCustomizations) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { root, home, work, data } = personHome();
      try {
        const { cwd, marks } = place(root, work);
        const gemini = yield* standIn();
        const base = localGeminiEnv(home, gemini.url);
        yield* prepareOwnedAntigravityHome(data, home, base);
        const bare = yield* Effect.promise(() =>
          acp(
            base,
            ["--gemini-dir", antigravityGeminiDir(data)],
            cwd,
            sessionServer(join(root, "own")),
            "hi",
          ),
        );
        try {
          yield* Effect.promise(() =>
            vi.waitFor(
              () => {
                expect(existsSync(marks.hook)).toBe(true);
                expect(existsSync(marks.server)).toBe(true);
              },
              { timeout: 30_000 },
            ),
          );
        } finally {
          yield* Effect.promise(bare.stop);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

describe("Gram's own Antigravity home", () => {
  it.effect("holds only Gram's settings, keeps the person's HOME, and drops config overrides", () =>
    Effect.gen(function* () {
      const { root, home, data } = personHome();
      try {
        const env = yield* prepareOwnedAntigravityHome(data, home, {
          HOME: home,
          PATH: "/usr/bin",
          GEMINI_API_KEY: "placeholder",
          ANTIGRAVITY_CONFIG_REL_DIR: ".elsewhere",
          ANTIGRAVITY_PERM_GRANTS: "command(*)",
          ANTIGRAVITY_PLUGIN_SHIM_DIR: join(home, "shims"),
        });
        const dir = antigravityGeminiDir(data);
        expect(dir).toBe(join(data, "antigravity-owned-home", ".gemini"));
        expect(env).toEqual({ HOME: home, PATH: "/usr/bin", GEMINI_API_KEY: "placeholder" });
        expect(
          JSON.parse(readFileSync(join(dir, "antigravity-cli", "settings.json"), "utf8")),
        ).toEqual(ownedAntigravitySettings());
        expect(JSON.parse(readFileSync(join(dir, "config", "mcp_config.json"), "utf8"))).toEqual({
          mcpServers: {},
        });
        expect(statSync(join(data, "antigravity-owned-home")).mode & 0o777).toBe(0o700);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("refuses to run in the person's own ~/.gemini", () =>
    Effect.gen(function* () {
      const { root } = personHome();
      try {
        const home = join(root, "data", "antigravity-owned-home");
        const exit = yield* Effect.exit(
          prepareOwnedAntigravityHome(join(root, "data"), home, { HOME: home }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect.skipIf(agyPremiseSkip !== undefined)(
    `keeps the person's MCP servers from Antigravity${agyPremiseSkip ? ` (${agyPremiseSkip})` : ""}`,
    () =>
      Effect.gen(function* () {
        const { root, home, work, marker, own, data } = personHome();
        try {
          const gemini = yield* standIn();
          const base = localGeminiEnv(home, gemini.url);
          const unowned = yield* Effect.promise(() => acp(base, [], work, sessionServer(own)));
          try {
            yield* Effect.promise(() =>
              vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 30_000 }),
            );
          } finally {
            yield* Effect.promise(unowned.stop);
          }
          rmSync(marker);
          rmSync(own, { force: true });
          const env = yield* prepareOwnedAntigravityHome(data, home, base);
          const owned = yield* Effect.promise(() =>
            acp(env, ["--gemini-dir", antigravityGeminiDir(data)], work, sessionServer(own)),
          );
          try {
            yield* Effect.promise(() =>
              vi.waitFor(() => expect(existsSync(own)).toBe(true), { timeout: 30_000 }),
            );
          } finally {
            yield* Effect.promise(owned.stop);
          }
          expect(existsSync(marker)).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }),
    120_000,
  );

  for (const { name, place, skipReason } of repoWorkspaces) {
    it.effect(`refuses ${name}`, () => refuseRepoCustomizations(place));
    it.effect.skipIf(skipReason !== undefined)(
      `agy runs the customizations in ${name}${skipReason ? ` (${skipReason})` : ""}`,
      () => agyRunsRepoCustomizations(place),
      120_000,
    );
  }

  it.effect.skipIf(!live)(
    "keeps the person's allow rules from Antigravity, and its commands see their HOME",
    () =>
      Effect.gen(function* () {
        const { root, home, work, data } = personHome();
        try {
          const base = { PATH: process.env["PATH"] ?? "/usr/bin", HOME: home };
          const prompt = "Run exactly this shell command: echo $HOME";
          const server = sessionServer(join(root, "unused"));
          const unowned = yield* Effect.promise(() => acp(base, [], work, server, prompt));
          yield* Effect.promise(unowned.stop);
          expect(unowned.asked).toBe(false);
          const env = yield* prepareOwnedAntigravityHome(data, home, base);
          const owned = yield* Effect.promise(() =>
            acp(env, ["--gemini-dir", antigravityGeminiDir(data)], work, server, prompt),
          );
          yield* Effect.promise(owned.stop);
          expect(owned.asked).toBe(true);
          expect(owned.output).toContain(home);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }),
    300_000,
  );
});
