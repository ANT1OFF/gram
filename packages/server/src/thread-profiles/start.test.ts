// The acceptance test for threads started from a profile: through the RPC handler, on the fake
// agent, with the hosted features off and on.
import { describe, expect, it } from "@effect/vitest";
import {
  applySettingsPatch,
  InvalidState,
  ProfileId,
  type Thread,
  ThreadId,
  type ThreadProfile,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPlatformTest } from "../git/platform.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { closedThreadHandlers } from "../rpc/handlers/closed-threads.ts";
import { threadHandlers } from "../rpc/handlers/threads.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { CheckoutService, TurnHooks } from "../runtime/hooks.ts";
import { makeRuntimeTestLayer, TEST_CONFIG, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { PROFILE_THREADS_DIR, PROFILE_THREADS_PROJECT, PROFILES_OFF } from "./start.ts";

const GATEWAY = "https://mcp.example.test/workspace";

/** A profile as a supplier compiles one: every part the shape has, on a workplace of its own. */
const profile = (over: Partial<ThreadProfile> = {}): ThreadProfile => ({
  version: 1,
  name: "Release notes",
  source: { id: "template-7", version: "3" },
  agent: "claude",
  charter: "You write release notes. Never publish without asking.",
  files: [{ path: "AGENTS.md", content: "# House rules\n" }],
  skills: [
    {
      name: "changelog",
      description: 'Drafts a changelog: "what changed", in order.',
      body: "Read the merged pull requests, then draft.",
      files: [{ path: "reference/style.md", content: "Short sentences.\n" }],
    },
  ],
  model: { model: "fake-model", effort: "high", fallbacks: [{ model: "fake-small" }] },
  connectors: { server: { name: "workspace", url: GATEWAY } },
  autonomy: "supervised",
  workplace: { kind: "scratch" },
  ...over,
});

const serverOver = (dataDir: string) =>
  Layer.merge(
    makeRuntimeTestLayer(TurnHooks.layerNoop, CheckoutService.layerNoGit, {
      ...TEST_CONFIG,
      dataDir,
    }),
    gitPlatformTest(),
  );

/** A server over a data folder of its own, removed when the test ends. */
const withServer = <A, E>(
  body: (dataDir: string) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof serverOver>>>,
) =>
  Effect.suspend(() => {
    const dataDir = mkdtempSync(join(tmpdir(), "gram-thread-profile-"));
    return body(dataDir).pipe(
      Effect.provide(serverOver(dataDir)),
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    );
  });

const turnOn = Effect.gen(function* () {
  const store = yield* ThreadStore;
  yield* store.updateSettings(
    (settings) => applySettingsPatch(settings, { experimental: { embedding: true } }),
    [["experimental", "embedding"]],
  );
});

const start = (value: unknown) =>
  Effect.flatMap(threadHandlers, (handlers) =>
    handlers["thread.createFromProfile"]({ profile: value }),
  );

/** The folders made for profile threads under `dataDir`. */
const folders = (dataDir: string) => {
  const root = join(dataDir, PROFILE_THREADS_DIR);
  return existsSync(root) ? readdirSync(root) : [];
};

describe("thread.createFromProfile", () => {
  it.effect("is refused, and makes nothing, while the hosted features are off", () =>
    withServer((dataDir) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const refused = yield* start(profile()).pipe(Effect.flip);
        expect(refused).toEqual(new InvalidState({ message: PROFILES_OFF }));
        expect(yield* store.listThreads).toEqual([]);
        expect(yield* store.listProjects).toEqual([]);
        expect(fake.sessions).toHaveLength(0);
        expect(folders(dataDir)).toEqual([]);
      }),
    ),
  );

  it.effect("starts a thread with the profile's charter, files, skills, model and server", () =>
    withServer((dataDir) =>
      Effect.gen(function* () {
        yield* turnOn;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const thread = yield* start(profile());

        // Its own new folder, filed under the one project such threads share.
        const folder = join(dataDir, PROFILE_THREADS_DIR, thread.id);
        expect(thread.checkout).toEqual({ kind: "main", path: folder });
        const [project] = yield* store.listProjects;
        expect(project?.id).toBe(thread.projectId);
        expect(project?.name).toBe(PROFILE_THREADS_PROJECT);

        // The model, and a mode that runs with nobody at the composer.
        expect(thread.model).toEqual({ agent: "claude", model: "fake-model", variant: "high" });
        expect(thread.mode).toBe("auto");
        // Titled for the profile, but not as the user's own name for it.
        expect(thread.title).toBe("Release notes");
        expect(thread.userNamed).toBe(false);

        // What it keeps of the profile.
        expect(thread.profile).toEqual({
          name: "Release notes",
          source: { id: "template-7", version: "3" },
          charter: "You write release notes. Never publish without asking.",
          autonomy: "supervised",
          server: { name: "workspace", url: GATEWAY },
          fallbacks: [{ model: "fake-small" }],
        });

        // The files, and the skill where Claude Code reads a folder's skills.
        expect(readFileSync(join(folder, "AGENTS.md"), "utf8")).toBe("# House rules\n");
        expect(readFileSync(join(folder, ".claude/skills/changelog/SKILL.md"), "utf8")).toBe(
          [
            "---",
            "name: changelog",
            'description: "Drafts a changelog: \\"what changed\\", in order."',
            "---",
            "",
            "Read the merged pull requests, then draft.",
            "",
          ].join("\n"),
        );
        expect(
          readFileSync(join(folder, ".claude/skills/changelog/reference/style.md"), "utf8"),
        ).toBe("Short sentences.\n");

        // The session it opened: in that folder, under the charter, held to the one server.
        expect(fake.sessions).toHaveLength(1);
        const { options } = fake.sessions[0]!;
        expect(options.cwd).toBe(folder);
        expect(options.model).toEqual(thread.model);
        expect(options.instructions).toBe("You write release notes. Never publish without asking.");
        expect(options.outwardGate).toBe("all");
        expect(options.mcpServer).toEqual({ name: "workspace", url: GATEWAY });
        expect(options.mcpAllowlist).toEqual([GATEWAY]);
        expect(options.mcpDenylist).toBeUndefined();
        expect(options.audience).toBe("plain");
      }),
    ),
  );

  it.effect("gives the charter and the server again each time the session reopens", () =>
    withServer(() =>
      Effect.gen(function* () {
        yield* turnOn;
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const thread = yield* start(profile({ input: "Draft the notes for 2.4." }));
        // The first message went to the session the profile opened.
        const first = yield* waitFor(
          "the first send",
          Effect.sync(() => fake.sessions[0]),
        );
        yield* waitFor(
          "the input",
          Effect.sync(() => first.sent.length === 1),
        );
        expect(first.sent[0]?.text).toBe("Draft the notes for 2.4.");
        yield* first.completeTurn("Drafted.");
        yield* waitFor(
          "the turn's end",
          runtimes.status(thread.id).pipe(Effect.map((status) => status === "idle")),
        );

        expect(yield* runtimes.restartSession(thread.id)).toBe("restarting");
        const second = yield* waitFor(
          "the reopened session",
          Effect.sync(() => fake.sessions[1]),
        );
        expect(second.options.instructions).toBe(first.options.instructions);
        expect(second.options.mcpServer).toEqual({ name: "workspace", url: GATEWAY });
        expect(second.options.mcpAllowlist).toEqual([GATEWAY]);
        expect(second.options.outwardGate).toBe("all");
      }),
    ),
  );

  it.effect("keeps its profile, folder and project through a close and a reopen", () =>
    withServer(() =>
      Effect.gen(function* () {
        yield* turnOn;
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const closed = yield* closedThreadHandlers;
        const thread = yield* start(profile());
        yield* waitFor(
          "idle",
          runtimes.status(thread.id).pipe(Effect.map((status) => status === "idle")),
        );
        yield* runtimes.close(thread.id);
        expect(yield* store.listThreads).toEqual([]);

        const back = yield* closed["threads.closed.reopen"]();
        expect(back?.thread).toMatchObject({
          id: thread.id,
          projectId: thread.projectId,
          checkout: thread.checkout,
          profile: thread.profile,
        });
        expect(yield* store.listProjects).toHaveLength(1);
        const reopened = yield* waitFor(
          "its session",
          Effect.sync(() => fake.sessions[1]),
        );
        expect(reopened.options.instructions).toBe(thread.profile?.charter);
        expect(reopened.options.mcpAllowlist).toEqual([GATEWAY]);
        expect(reopened.options.mcpServer).toEqual({ name: "workspace", url: GATEWAY });
      }),
    ),
  );

  it.effect("holds a fork to the profile its source was started from", () =>
    withServer(() =>
      Effect.gen(function* () {
        yield* turnOn;
        const runtimes = yield* ThreadRuntimes;
        const handlers = yield* threadHandlers;
        const fake = yield* FakeAgentControl;
        const thread = yield* start(profile({ input: "Draft the notes." }));
        const session = yield* waitFor(
          "its session",
          Effect.sync(() => fake.sessions[0]),
        );
        yield* waitFor(
          "the input",
          Effect.sync(() => session.sent.length === 1),
        );
        yield* session.completeTurn("Drafted.");
        yield* waitFor(
          "idle",
          runtimes.status(thread.id).pipe(Effect.map((status) => status === "idle")),
        );
        // A fork goes into its source's folder only once the source's session has gone cold.
        yield* TestClock.adjust("16 minutes");
        yield* waitFor(
          "cold",
          runtimes.status(thread.id).pipe(Effect.map((status) => status === "cold")),
        );
        const fork = yield* handlers["thread.fork"]({ threadId: thread.id });
        expect(fork.id).not.toBe(thread.id);
        expect(fork.profile).toEqual(thread.profile);
      }),
    ),
  );

  it.effect("holds a profile with no server to no MCP server but Gram's own", () =>
    withServer((dataDir) =>
      Effect.gen(function* () {
        yield* turnOn;
        const fake = yield* FakeAgentControl;
        const thread = yield* start(
          profile({
            agent: "codex",
            connectors: {},
            autonomy: "full",
            workplace: { kind: "none" },
          }),
        );
        const { options } = fake.sessions[0]!;
        expect(options.mcpAllowlist).toEqual([]);
        expect(options.mcpServer).toBeUndefined();
        expect(options.outwardGate).toBeUndefined();
        expect(options.instructions).toBe("You write release notes. Never publish without asking.");
        // And its skills go where Codex reads a folder's skills.
        const folder = join(dataDir, PROFILE_THREADS_DIR, thread.id);
        expect(existsSync(join(folder, ".agents/skills/changelog/SKILL.md"))).toBe(true);
        expect(existsSync(join(folder, ".claude"))).toBe(false);
        expect(thread.profile?.server).toBeUndefined();
      }),
    ),
  );

  it.effect("refuses what it can't apply whole, and makes nothing", () =>
    withServer((dataDir) =>
      Effect.gen(function* () {
        yield* turnOn;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const refusals: ReadonlyArray<readonly [string, unknown, string]> = [
          ["a key this version doesn't know", { ...profile(), mandate: "anything" }, "mandate"],
          ["another version", { ...profile(), version: 2 }, "version"],
          [
            "a file outside the folder",
            profile({ files: [{ path: "../outside.txt", content: "" }] }),
            '".."',
          ],
          [
            "a file in the repository's own folder",
            profile({ files: [{ path: ".git/hooks/pre-commit", content: "" }] }),
            ".git",
          ],
          [
            "a credential in the server's address",
            profile({
              connectors: {
                server: { name: "workspace", url: "https://user:pw@mcp.example.test" },
              },
            }),
            "without a user name",
          ],
          [
            "a server named as Gram's own",
            profile({ connectors: { server: { name: "gram", url: GATEWAY } } }),
            "Gram's own",
          ],
          [
            "a gateway profile that isn't here",
            profile({ model: { model: "fake-model", gatewayProfile: ProfileId.make("missing") } }),
            "no gateway profile missing",
          ],
        ];
        for (const [what, value, says] of refusals) {
          const refused = yield* start(value).pipe(Effect.flip);
          expect(refused, what).toBeInstanceOf(InvalidState);
          expect(refused.message, what).toContain(says);
        }
        expect(yield* store.listThreads).toEqual([]);
        expect(fake.sessions).toHaveLength(0);
        expect(folders(dataDir)).toEqual([]);
      }),
    ),
  );

  it.effect("hands back the thread, in error, when its agent can't open", () =>
    withServer((dataDir) =>
      Effect.gen(function* () {
        yield* turnOn;
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        yield* fake.setUnavailable("The CLI isn't installed.");
        // As `thread.create` does: the thread is there to be seen and tried again, not lost.
        const thread = yield* start(profile());
        expect(yield* runtimes.status(thread.id)).not.toBe("idle");
        expect((yield* store.listThreads).map((t) => t.id)).toEqual([thread.id]);
        expect(folders(dataDir)).toEqual([thread.id]);
        expect(fake.sessions).toHaveLength(0);
      }),
    ),
  );

  it.effect("leaves every other thread's sessions as they were", () =>
    withServer((dataDir) =>
      Effect.gen(function* () {
        yield* turnOn;
        const handlers = yield* threadHandlers;
        const fake = yield* FakeAgentControl;
        const plain: Thread = yield* handlers["thread.create"]({
          projectRoot: dataDir,
          checkout: { kind: "current" },
          model: { agent: "claude", model: "fake-model" },
        });
        expect(plain.profile).toBeUndefined();
        const { options } = fake.sessions[0]!;
        expect(options.instructions).toBeUndefined();
        expect(options.mcpAllowlist).toBeUndefined();
        expect(options.mcpServer).toBeUndefined();
        expect(options.outwardGate).toBeUndefined();
      }),
    ),
  );

  it.effect("makes one thread for an id the caller supplies, however often it is asked", () =>
    withServer((dataDir) =>
      Effect.gen(function* () {
        yield* turnOn;
        const handlers = yield* threadHandlers;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const threadId = ThreadId.make("3f0c7c3e-8a51-4b7e-9d0a-6f1b2c3d4e5f");
        const ask = (value: unknown) =>
          handlers["thread.createFromProfile"]({ profile: value, threadId });
        // Two asks at once and one after: the same thread, made once.
        const [first, second] = yield* Effect.all([ask(profile()), ask(profile())], {
          concurrency: 2,
        });
        const third: Thread = yield* ask(profile({ charter: "Another charter." }));
        expect(first.id).toBe(threadId);
        expect(second.id).toBe(threadId);
        expect(third.id).toBe(threadId);
        // The profile that came with the first ask is the thread's; a later one changes nothing.
        expect(third.profile?.charter).toBe(profile().charter);
        expect((yield* store.listThreads).map((thread) => thread.id)).toEqual([threadId]);
        expect(folders(dataDir)).toEqual([threadId]);
        expect(fake.sessions).toHaveLength(1);

        // An id that is no UUID names no folder; another thread's id isn't taken over.
        const shaped = yield* handlers["thread.createFromProfile"]({
          profile: profile(),
          threadId: ThreadId.make("../elsewhere"),
        }).pipe(Effect.flip);
        expect(shaped.message).toContain("lowercase UUID");
        const plain: Thread = yield* handlers["thread.create"]({
          projectRoot: dataDir,
          checkout: { kind: "current" },
          model: { agent: "claude", model: "fake-model" },
        });
        const taken = yield* handlers["thread.createFromProfile"]({
          profile: profile(),
          threadId: plain.id,
        }).pipe(Effect.flip);
        expect(taken.message).toBe("That thread id is another thread's.");

        // Once closed, the id doesn't start a second thread behind the first one's back.
        yield* handlers["thread.close"]({ threadId });
        const closed = yield* ask(profile()).pipe(Effect.flip);
        expect(closed.message).toBe("The thread with that id was closed.");
        expect((yield* store.listThreads).map((thread) => thread.id)).toEqual([plain.id]);
      }),
    ),
  );
});
