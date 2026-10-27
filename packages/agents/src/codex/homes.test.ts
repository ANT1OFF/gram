import { describe, expect, it } from "@effect/vitest";
import { ProfileId, ThreadId, type AgentEvent, type GatewayProfile } from "@gram/contracts";
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { GatewayKeyProvider } from "../gateway.ts";
import type { AgentHost, OpenSessionOptions } from "../host.ts";
import { captureLogs } from "../testing/logs.ts";
import { outwardPromptRules } from "./gate-rules.ts";
import { CodexServersLive } from "./servers.ts";
import { CodexHost, CodexHostLayer } from "./session.ts";

const profile: GatewayProfile = {
  id: ProfileId.make("litellm"),
  name: "LiteLLM",
  baseURL: "http://127.0.0.1:9/v1",
  keyRef: "profile:litellm",
  models: [
    { id: "m", name: "m" },
    { id: "gpt-6.1-sol", name: "gpt-6.1-sol" },
  ],
};
const model = { agent: "codex" as const, model: "m", profileId: profile.id };

const keys = Layer.succeed(GatewayKeyProvider)({
  credentials: () => Effect.succeed({ profile, key: Redacted.make("gram-test-key") }),
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls `probe` every 50 ms until it holds, dying after 10 s. */
const poll = (what: string, probe: () => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (probe()) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`));
  });

/**
 * A fake `codex app-server` that keeps each `CODEX_HOME`'s threads in that home's `threads.json`, so
 * a thread can only be resumed or forked by a server on the home it was started in. Each server
 * records its pid and home.
 */
const writeFakeCodex = (dir: string) => {
  const serversFile = join(dir, "servers.log");
  const catalogsFile = join(dir, "catalogs.log");
  const skillsFile = join(dir, "skills.log");
  const binary = join(dir, "codex");
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("0.0.0"); process.exit(0); }
const home = process.env.CODEX_HOME;
if (args[0] === "debug") {
  fs.appendFileSync(${JSON.stringify(catalogsFile)}, "dump " + home + "\\n");
  console.log(JSON.stringify({ models: [{ slug: "gpt-6-sol", context_window: 1 }] }));
  process.exit(0);
}
const catalog = args.find((arg) => arg.startsWith("model_catalog_json="));
if (catalog) fs.appendFileSync(${JSON.stringify(catalogsFile)}, catalog + "\\n");
fs.appendFileSync(${JSON.stringify(serversFile)}, process.pid + " " + home + "\\n");
const file = path.join(home, "threads.json");
const approvals = new Map();
const rulesIn = (dir) => fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((name) => name.endsWith(".rules")).map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("\\n") : "";
const execute = (command, cwd) => {
  require("node:child_process").execSync(command, { cwd, env: { ...process.env, PATH: ${JSON.stringify(dir)} + path.delimiter + process.env.PATH } });
};
const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
const save = (threads) => fs.writeFileSync(file, JSON.stringify(threads));
let next = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined && approvals.has(m.id)) {
    const pending = approvals.get(m.id);
    approvals.delete(m.id);
    if (m.result.decision === "accept") execute(pending.command, pending.cwd);
    return;
  }
  if (m.id === undefined || m.method === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ id: m.id, result }) + "\\n");
  const fail = (message) =>
    process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32600, message } }) + "\\n");
  const threads = load();
  const p = m.params || {};
  // Codex loads its catalog afresh for each thread, and names no path when it is gone.
  const configGone = () =>
    catalog !== undefined && !fs.existsSync(JSON.parse(catalog.slice(catalog.indexOf("=") + 1)));
  if (m.method.startsWith("thread/") && m.method !== "thread/list" && m.method !== "thread/unsubscribe" && configGone()) {
    return fail("failed to load configuration: No such file or directory (os error 2)");
  }
  const add = (id) => {
    const rules = rulesIn(path.join(home, "rules")) || false;
    threads[id] = { cwd: p.cwd, updatedAt: Date.now() / 1000, rules };
    save(threads);
    reply({ thread: { id }, model: "m" });
  };
  switch (m.method) {
    case "account/read":
      return reply({ account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true });
    case "turn/start": {
      reply({ turn: { id: "turn_1" } });
      const t = threads[p.threadId];
      const command = p.input[0].text;
      const rules = (t.rules || "") + "\\n" + rulesIn(path.join(t.cwd, ".codex", "rules"));
      const words = command.split(" ");
      const decisions = rules.split("\\n").flatMap((line) => {
        const match = /prefix_rule\\(pattern=(\\[[^\\n]+?\\]),\\s*decision="(prompt|allow)"/.exec(line);
        if (!match) return [];
        const pattern = JSON.parse(match[1]);
        return pattern.every((part, i) => Array.isArray(part) ? part.includes(words[i]) : part === words[i])
          ? [match[2]] : [];
      });
      // Synthetic Codex exec-policy precedence: a prompt outranks an allow. Without that
      // backstop, an existing allow runs before the adapter ever hears of the command.
      if (decisions.includes("allow") && !decisions.includes("prompt")) {
        execute(command, t.cwd);
        return;
      }
      approvals.set(700, { command, cwd: t.cwd });
      process.stdout.write(JSON.stringify({ id: 700, method: "item/commandExecution/requestApproval", params: {
        kind: "command", threadId: p.threadId, turnId: "turn_1", itemId: "push", startedAtMs: 1,
        environmentId: null, command, cwd: t.cwd, commandActions: [],
        availableDecisions: ["accept", "acceptForSession", "decline"], proposedExecpolicyAmendment: ["git", "push"],
      } }) + "\\n");
      return;
    }
    case "thread/start":
      return add("thr_" + process.pid + "_" + next++);
    case "thread/resume":
      return threads[p.threadId]
        ? reply({ thread: { id: p.threadId }, model: "m" })
        : fail("no rollout found for thread id " + p.threadId);
    case "thread/fork":
      return threads[p.threadId]
        ? add(p.threadId + "_fork" + next++)
        : fail("no rollout found for thread id " + p.threadId);
    case "thread/unsubscribe":
      reply({ status: "unsubscribed" });
      process.stdout.write(JSON.stringify({ method: "thread/closed", params: { threadId: p.threadId } }) + "\\n");
      return;
    case "skills/extraRoots/set":
      fs.appendFileSync(${JSON.stringify(skillsFile)}, home + " " + p.extraRoots.join(",") + "\\n");
      return p.extraRoots.some((root) => root.endsWith("unsupported"))
        ? fail("unknown method skills/extraRoots/set")
        : reply({});
    case "model/list":
      // Two pages, so a caller that reads only the first misses the clone.
      return reply(
        p.cursor === "2"
          ? { data: [{ id: "gpt-6.1-sol" }], nextCursor: null }
          : { data: [{ id: "gpt-6-sol" }], nextCursor: "2" },
      );
    case "thread/list":
      return reply({
        data: Object.entries(threads).map(([id, t]) => ({
          id, cwd: t.cwd, preview: "p", name: null, parentThreadId: null, ephemeral: false,
          updatedAt: t.updatedAt, gitInfo: null,
        })),
        nextCursor: null,
      });
    default:
      return reply({});
  }
});
`,
  );
  chmodSync(binary, 0o755);
  const git = join(dir, "git");
  writeFileSync(
    git,
    `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(join(dir, "executions.log"))}, process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  chmodSync(git, 0o755);
  const servers = () =>
    (existsSync(serversFile) ? readFileSync(serversFile, "utf8").trim().split("\n") : []).map(
      (line) => {
        const [pid, home] = line.split(" ");
        return { pid: Number(pid), home: home ?? "" };
      },
    );
  const catalogs = () =>
    existsSync(catalogsFile) ? readFileSync(catalogsFile, "utf8").trim().split("\n") : [];
  const skillRoots = () =>
    existsSync(skillsFile) ? readFileSync(skillsFile, "utf8").trim().split("\n") : [];
  return { binary, servers, catalogs, skillRoots };
};

const threadsIn = (home: string): ReadonlyArray<string> => {
  const file = join(home, "threads.json");
  return existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, "utf8"))) : [];
};

const seed = (home: string, threads: Record<string, number>) =>
  writeFileSync(
    join(home, "threads.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(threads).map(([id, updatedAt]) => [id, { cwd: "/repo", updatedAt }]),
      ),
    ),
  );

interface Homes {
  readonly host: AgentHost;
  readonly userHome: string;
  readonly gatewayHome: string;
  readonly ownedHome: string;
  readonly repo: string;
  readonly executions: () => string;
  readonly setOwnedReady: (ready: boolean) => void;
  readonly servers: () => ReadonlyArray<{ readonly pid: number; readonly home: string }>;
  /** The `debug models` dumps and the `model_catalog_json` flags the fake saw, in order. */
  readonly catalogs: () => ReadonlyArray<string>;
  /** Each `skills/extraRoots/set` the fake saw: the server's home, then the roots. */
  readonly skillRoots: () => ReadonlyArray<string>;
  /** How many times the gateway home was refreshed. */
  readonly refreshes: () => number;
}

/** A real `CodexHost` over the fake binary, with the user's home and the gateway home in a temp dir. */
const withHomes = <A>(
  body: (homes: Homes) => Effect.Effect<A, unknown, Scope.Scope>,
  skillRoots: ReadonlyArray<string> = [],
  afterClose?: (gatewayHome: string) => void,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-codex-homes-"))),
    (dir) => {
      const userHome = join(dir, "user");
      const gatewayHome = join(dir, "gateway");
      const ownedHome = join(dir, "owned");
      const repo = join(dir, "repo");
      mkdirSync(ownedHome);
      mkdirSync(repo);
      mkdirSync(userHome);
      mkdirSync(gatewayHome);
      const fake = writeFakeCodex(dir);
      let refreshes = 0;
      let ownedReady = true;
      const layer = CodexHostLayer().pipe(
        Layer.provide(
          CodexServersLive({
            binaryPath: fake.binary,
            shell: "/bin/sh",
            extraEnv: { CODEX_HOME: userHome },
            ownedHome: {
              prepare: () =>
                Effect.sync(() => {
                  if (!ownedReady) throw new Error("synthetic native preparation failure");
                  writeFileSync(join(ownedHome, "config.toml"), "");
                  return ownedHome;
                }),
              rules: {
                install: (level) =>
                  Effect.sync(() => {
                    mkdirSync(join(ownedHome, "rules"), { recursive: true });
                    writeFileSync(
                      join(ownedHome, "rules", "gate.rules"),
                      outwardPromptRules(level),
                    );
                  }),
                remove: Effect.sync(() =>
                  rmSync(join(ownedHome, "rules", "gate.rules"), { force: true }),
                ),
              },
            },
            gatewayHome: () =>
              Effect.sync(() => {
                writeFileSync(join(gatewayHome, "config.toml"), "");
                return gatewayHome;
              }),
            releaseGatewayHome: Effect.sync(() =>
              rmSync(join(gatewayHome, "config.toml"), { force: true }),
            ),
            gatewaySkillRoots: () => Effect.succeed(skillRoots),
            refreshGatewayHome: () =>
              Effect.sync(() => {
                refreshes++;
              }),
            gateRules: {
              install: (level) =>
                Effect.sync(() => {
                  mkdirSync(join(gatewayHome, "rules"), { recursive: true });
                  writeFileSync(join(gatewayHome, "rules", "gate.rules"), level);
                }),
              remove: Effect.sync(() =>
                rmSync(join(gatewayHome, "rules", "gate.rules"), { force: true }),
              ),
            },
          }),
        ),
        Layer.provide(keys),
      );
      return Effect.gen(function* () {
        return yield* body({
          host: yield* CodexHost,
          userHome,
          gatewayHome,
          ownedHome,
          repo,
          setOwnedReady: (ready) => {
            ownedReady = ready;
          },
          executions: () =>
            existsSync(join(dir, "executions.log"))
              ? readFileSync(join(dir, "executions.log"), "utf8")
              : "",
          servers: fake.servers,
          catalogs: fake.catalogs,
          skillRoots: fake.skillRoots,
          refreshes: () => refreshes,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(layer),
        Effect.tap(() => Effect.sync(() => afterClose?.(gatewayHome))),
      );
    },
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );

/** Opens a session, reads its identity, and closes it again. */
const identityOf = (host: AgentHost, options: Partial<OpenSessionOptions>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* host.open({ threadId: ThreadId.make("t1"), cwd: "/repo", ...options });
      const events = yield* Stream.runCollect(
        session.events.pipe(
          Stream.filter((event) => event.type === "identity"),
          Stream.take(1),
        ),
      );
      return events[0] as Extract<AgentEvent, { type: "identity" }>;
    }),
  );

describe.skipIf(process.platform === "win32")("Codex homes over real app-servers", () => {
  it.live(
    "reopens and forks a thread with no recorded home on the user's home and a gateway thread on the gateway's",
    () =>
      withHomes(({ host, userHome, gatewayHome }) =>
        Effect.gen(function* () {
          seed(userHome, { thr_user: 1 });

          // A thread with no recorded home lives in ~/.codex, even one on a gateway profile.
          expect(yield* identityOf(host, { resumeId: "thr_user", model })).toMatchObject({
            agentSessionId: "thr_user",
            codexHome: "user",
          });
          const userFork = yield* identityOf(host, { resumeId: "thr_user", fork: true, model });
          expect(userFork.codexHome).toBe("user");
          expect(threadsIn(userHome)).toContain(userFork.agentSessionId);

          const created = yield* identityOf(host, { model });
          expect(created.codexHome).toBe("gateway");
          expect(threadsIn(gatewayHome)).toEqual([created.agentSessionId]);
          expect(threadsIn(userHome)).not.toContain(created.agentSessionId);

          // All scopes on this owner have closed; explicit retirement supplies child-exit proof.
          yield* host.reloadConfig!(model.profileId);
          const pinned = { resumeId: created.agentSessionId, codexHome: "gateway" as const, model };
          expect(yield* identityOf(host, pinned)).toMatchObject({
            agentSessionId: created.agentSessionId,
            codexHome: "gateway",
          });
          const gatewayFork = yield* identityOf(host, { ...pinned, fork: true });
          expect(threadsIn(gatewayHome)).toContain(gatewayFork.agentSessionId);

          // The other home doesn't have it: that's what pinning a thread to its home avoids.
          const wrongHome = yield* Effect.flip(identityOf(host, { ...pinned, codexHome: "user" }));
          expect(wrongHome).toMatchObject({ _tag: "AgentUnavailable" });
        }),
      ),
    60_000,
  );

  it.live(
    "has the gate's rules in the gateway home only while a gated thread opens",
    () =>
      withHomes(({ host, gatewayHome }) =>
        Effect.gen(function* () {
          const sawRules = (id: string): unknown =>
            JSON.parse(readFileSync(join(gatewayHome, "threads.json"), "utf8"))[id].rules;
          const gated = yield* identityOf(host, { model, outwardGate: true });
          expect(sawRules(gated.agentSessionId)).toBe("all");
          expect(existsSync(join(gatewayHome, "rules", "gate.rules"))).toBe(false);

          // Each level's thread starts under its own rules, whichever opened before it.
          const publishing = yield* identityOf(host, { model, outwardGate: "irreversible" });
          expect(sawRules(publishing.agentSessionId)).toBe("irreversible");
          expect(existsSync(join(gatewayHome, "rules", "gate.rules"))).toBe(false);
          const supervised = yield* identityOf(host, { model, outwardGate: "all" });
          expect(sawRules(supervised.agentSessionId)).toBe("all");

          // Under an ungated bypass session's `never` policy a prompt rule rejects the push outright.
          const plain = yield* identityOf(host, { model, permissionMode: "bypassPermissions" });
          expect(sawRules(plain.agentSessionId)).toBe(false);

          const fork = yield* identityOf(host, {
            resumeId: gated.agentSessionId,
            codexHome: "gateway",
            fork: true,
            model,
            outwardGate: "irreversible",
          });
          expect(sawRules(fork.agentSessionId)).toBe("irreversible");

          // The user's own home is never gated: it may hold allow rules, and nothing is written there.
          const own = yield* Effect.flip(
            identityOf(host, { outwardGate: true, codexHome: "user" }),
          );
          expect(own).toMatchObject({ _tag: "AgentUnavailable" });
        }),
      ),
    60_000,
  );

  it.live(
    "checks native preparation without inference, refuses failures and preserves owned history on reopen/fork",
    () =>
      withHomes(({ host, ownedHome, servers, setOwnedReady }) =>
        Effect.gen(function* () {
          expect(yield* host.nativeGateReady!).toBe(true);
          expect(servers()).toEqual([]);
          setOwnedReady(false);
          expect(yield* host.nativeGateReady!).toBe(false);
          const refused = yield* Effect.flip(identityOf(host, { outwardGate: true }));
          expect(refused).toMatchObject({ _tag: "AgentUnavailable" });
          expect(servers()).toEqual([]);
          setOwnedReady(true);
          const first = yield* identityOf(host, { outwardGate: true });
          expect(first.codexHome).toBe("owned");
          yield* host.reloadConfig!(undefined);
          const pinned = { resumeId: first.agentSessionId, codexHome: "owned" as const };
          expect(yield* identityOf(host, { ...pinned, outwardGate: "irreversible" })).toMatchObject(
            { agentSessionId: first.agentSessionId, codexHome: "owned" },
          );
          yield* host.reloadConfig!(undefined);
          const fork = yield* identityOf(host, { ...pinned, fork: true, outwardGate: "all" });
          expect(threadsIn(ownedHome)).toContain(fork.agentSessionId);
          // A gateway key must never enter the home linked to the native login.
          yield* Effect.flip(identityOf(host, { codexHome: "owned", model }));
        }),
      ),
    60_000,
  );

  for (const allowIn of ["user", "repo", "owned"] as const) {
    for (const level of ["all", "irreversible"] as const) {
      it.live(
        `holds an owned native push with an allow in ${allowIn} at ${level} until one approval`,
        () =>
          withHomes(({ host, userHome, ownedHome, repo, executions }) =>
            Effect.gen(function* () {
              const rules = join(
                allowIn === "repo"
                  ? join(repo, ".codex")
                  : allowIn === "user"
                    ? userHome
                    : ownedHome,
                "rules",
              );
              mkdirSync(rules, { recursive: true });
              const allow = 'prefix_rule(pattern=["git", "push"], decision="allow")';
              writeFileSync(join(rules, "allow.rules"), allow);
              const session = yield* host.open({
                threadId: ThreadId.make("native"),
                cwd: repo,
                outwardGate: level,
                permissionMode: "bypassPermissions",
              });
              const identities = yield* Stream.runCollect(
                session.events.pipe(
                  Stream.filter((e) => e.type === "identity"),
                  Stream.take(1),
                ),
              );
              expect(identities[0]).toMatchObject({ codexHome: "owned" });
              const saved = JSON.parse(readFileSync(join(ownedHome, "threads.json"), "utf8"));
              expect(Object.values(saved)).toEqual([
                expect.objectContaining({
                  rules: expect.stringContaining(outwardPromptRules(level)),
                }),
              ]);
              expect(existsSync(join(ownedHome, "rules", "gate.rules"))).toBe(false);
              // Publish permits ordinary pushes, but still asks before a forced push.
              const command =
                level === "all" ? "git push origin HEAD" : "git push --force origin HEAD";
              yield* session.send({ text: command });
              const cards = yield* Stream.runCollect(
                session.events.pipe(
                  Stream.filter((e) => e.type === "request"),
                  Stream.take(1),
                ),
              ).pipe(
                Effect.timeoutOrElse({
                  duration: "5 seconds",
                  orElse: () =>
                    Effect.die(new Error(`No approval card; executed: ${executions()}`)),
                }),
              );
              const card = cards[0]!;
              expect(card.request).toMatchObject({
                kind: "approval",
                input: { command, cwd: repo },
                scopes: ["once"],
              });
              expect(executions()).toBe("");
              yield* session.respond(card.request.id, {
                kind: "approval",
                decision: "allow",
                scope: "always",
              });
              yield* poll("approved push execution", () => executions() !== "");
              expect(executions()).toBe(command.slice(4) + "\n");
              expect(readFileSync(join(rules, "allow.rules"), "utf8")).toBe(allow);
            }),
          ),
        60_000,
      );
    }
  }

  it.live(
    "gives a gateway app-server the user's skill folders, and refreshes its home before each open",
    () =>
      withHomes(
        ({ host, gatewayHome, skillRoots, refreshes }) =>
          Effect.gen(function* () {
            yield* identityOf(host, {});
            expect(skillRoots()).toEqual([]);
            expect(refreshes()).toBe(0);

            const created = yield* identityOf(host, { model });
            yield* host.reloadConfig!(model.profileId);
            yield* identityOf(host, {
              resumeId: created.agentSessionId,
              codexHome: "gateway",
              model,
            });
            // Both freshly acquired children receive the same isolated roots.
            expect(skillRoots()).toEqual([
              `${gatewayHome} /u/.codex/skills`,
              `${gatewayHome} /u/.codex/skills`,
            ]);
            expect(refreshes()).toBe(2);
          }),
        ["/u/.codex/skills"],
      ),
    60_000,
  );

  it.live(
    "warns a gateway thread when Codex won't take the skill folders, and still opens it",
    () =>
      withHomes(
        ({ host }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* host.open({
                threadId: ThreadId.make("t1"),
                cwd: "/repo",
                model,
              });
              const notices = yield* Stream.runCollect(
                session.events.pipe(
                  Stream.takeUntil((event) => event.type === "identity"),
                  Stream.filter((event) => event.type === "notice"),
                ),
              );
              // The fake's 0.0.0 also earns a version-skew warning.
              expect(notices.map((n) => (n as { message: string }).message)).toContainEqual(
                expect.stringMatching(
                  /^Codex didn't take your skills in \/u\/unsupported, so gateway threads run without them/,
                ),
              );
            }),
          ),
        ["/u/unsupported"],
      ),
    60_000,
  );

  it.live(
    "knows the models on every page of the gateway app-server's catalog",
    () =>
      withHomes(({ host }) =>
        Effect.gen(function* () {
          expect(yield* host.knownModels!(profile.id)).toEqual(
            new Set(["gpt-6-sol", "gpt-6.1-sol"]),
          );
        }),
      ),
    60_000,
  );

  it.live(
    "gives a gateway app-server a catalog that adds the gateway models Codex doesn't know",
    () =>
      withHomes(({ host, gatewayHome, catalogs }) =>
        Effect.gen(function* () {
          yield* identityOf(host, { model });
          const file = join(gatewayHome, "gram-models", "litellm.json");
          // Codex's own catalog is dumped on the gateway home, never the user's.
          expect(catalogs()).toEqual([
            `dump ${gatewayHome}`,
            `model_catalog_json=${JSON.stringify(file)}`,
          ]);
          const written = JSON.parse(readFileSync(file, "utf8")) as {
            models: Array<{ slug: string; context_window: number }>;
          };
          expect(written.models.map((m) => [m.slug, m.context_window])).toEqual([
            ["gpt-6-sol", 1],
            ["gpt-6.1-sol", 272_000],
          ]);
        }),
      ),
    60_000,
  );

  it.live(
    "writes the gateway home's files again when they are removed under a running app-server",
    () =>
      withHomes(({ host, gatewayHome, servers }) =>
        Effect.gen(function* () {
          const config = join(gatewayHome, "config.toml");
          const catalog = join(gatewayHome, "gram-models", "litellm.json");
          // Keep a real session hold: ordinary last-scope close now retires its exact child.
          yield* host.open({ threadId: ThreadId.make("held-files"), cwd: "/repo", model });
          // Another Gram on the same data dir releases the home as it shuts down.
          rmSync(config);
          rmSync(join(gatewayHome, "gram-models"), { recursive: true });

          const logs = captureLogs();
          yield* identityOf(host, { model }).pipe(Effect.provide(logs.layer));
          expect(existsSync(config)).toBe(true);
          expect(existsSync(catalog)).toBe(true);
          expect(logs.warnings().map((log) => log.message)).toEqual([
            `codex gateway home lost ${config}, ${catalog} while its app-server ran; writing them again`,
          ]);
          expect(servers().filter((s) => s.home === gatewayHome)).toHaveLength(1);
        }),
      ),
    60_000,
  );

  it.live(
    "names the missing file when a thread can't open for one",
    () =>
      withHomes(({ host, gatewayHome }) =>
        Effect.gen(function* () {
          const catalogs = join(gatewayHome, "gram-models");
          yield* host.open({ threadId: ThreadId.make("held-catalog"), cwd: "/repo", model });
          rmSync(catalogs, { recursive: true });
          // Unwritable, so the catalog can't come back.
          writeFileSync(catalogs, "");

          const logs = captureLogs();
          const failed = yield* Effect.flip(identityOf(host, { model })).pipe(
            Effect.provide(logs.layer),
          );
          const catalog = join(catalogs, "litellm.json");
          expect(logs.warnings().map((log) => log.message)).toEqual([
            `codex gateway home lost ${catalog} while its app-server ran; writing it again`,
            expect.stringContaining("couldn't write the gateway model catalog: EEXIST"),
          ]);
          expect(failed).toMatchObject({
            _tag: "AgentUnavailable",
            message: `Codex couldn't open the thread: failed to load configuration: No such file or directory (os error 2); missing /repo, ${join(catalogs, "litellm.json")}`,
          });
        }),
      ),
    60_000,
  );

  it.live(
    "leaves the gateway home alone on shutdown when this run never prepared it",
    () =>
      withHomes(
        ({ host, gatewayHome }) =>
          Effect.gen(function* () {
            // The installed app's copy, which a dev server on the same data dir must not remove.
            writeFileSync(join(gatewayHome, "config.toml"), "");
            yield* identityOf(host, {});
          }),
        [],
        (gatewayHome) => expect(existsSync(join(gatewayHome, "config.toml"))).toBe(true),
      ),
    60_000,
  );

  it.live(
    "releases the gateway home's copied config when the server owner shuts down",
    () =>
      withHomes(
        ({ host, gatewayHome }) =>
          Effect.gen(function* () {
            yield* host.open({ threadId: ThreadId.make("shutdown"), cwd: "/repo", model });
            expect(existsSync(join(gatewayHome, "config.toml"))).toBe(true);
          }),
        [],
        (gatewayHome) => expect(existsSync(join(gatewayHome, "config.toml"))).toBe(false),
      ),
    60_000,
  );

  it.live(
    "lists both homes' sessions, and stops the gateway home's listing server afterwards",
    () =>
      withHomes(({ host, userHome, gatewayHome, servers }) => {
        const byHome = (home: string) => servers().filter((s) => s.home === home);
        return Effect.gen(function* () {
          seed(userHome, { thr_user: 1 });
          seed(gatewayHome, { thr_gateway: 2 });
          const sessions = yield* host.listSessions!({ cwd: "/repo" });
          expect(sessions.map((s) => [s.agentSessionId, s.codexHome])).toEqual([
            ["thr_gateway", "gateway"],
            ["thr_user", "user"],
          ]);

          expect(byHome(gatewayHome)).toHaveLength(1);
          yield* poll("the gateway listing server to exit", () =>
            byHome(gatewayHome).every((s) => !isAlive(s.pid)),
          );
          // With no app-server left on the gateway home, its copied config is removed.
          yield* poll(
            "the gateway home's config to be released",
            () => !existsSync(join(gatewayHome, "config.toml")),
          );
          // The user's keyless server is shared with model listing, so it stays up.
          expect(byHome(userHome).map((s) => isAlive(s.pid))).toEqual([true]);
        });
      }),
    60_000,
  );
});
