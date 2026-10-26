import { describe, expect, it } from "@effect/vitest";
import type { AppToolError, AppToolDescriptor, LaunchChecks, ThreadId } from "@gram/contracts";
import { Proc, type ProcOutput } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { homedir, release, type as osType } from "node:os";
import { AppToolRegistry, bindAppTools, defineAppTool } from "../app-tools/registry.ts";
import { LaunchChecksCache } from "../launch-checks/handler.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  composeIssue,
  confineIssueQuery,
  diagnosticsFooter,
  issueLabels,
  parseIssueSearch,
  scrubIssueText,
} from "./compose.ts";
import { issueHandlers } from "./handler.ts";
import { IssueReporter } from "./reporter.ts";
import { IssueAppToolsLive } from "./tools.ts";

interface GhCall {
  readonly args: ReadonlyArray<string>;
  readonly stdin: string | undefined;
}

const gh: { calls: Array<GhCall>; reply: ProcOutput } = {
  calls: [],
  reply: { status: 0, stdout: "", stderr: "", truncated: false },
};

const ok = (body: unknown): ProcOutput => ({
  status: 0,
  // `ghApi` asks for the headers and takes them back off.
  stdout: `HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
  stderr: "",
  truncated: false,
});

/** `gh` as the tests script it; nothing here ever reaches GitHub. */
const FakeGh = Layer.succeed(Proc, {
  run: (bin, args, { stdin }) =>
    Effect.sync(() => {
      if (bin !== "gh") throw new Error(`unexpected ${bin}`);
      gh.calls.push({ args, stdin });
      return gh.reply;
    }),
});

const checks: LaunchChecks = {
  checkedAt: 0,
  tools: [{ tool: "claude", found: true, version: "2.1.3" }],
  claudeSignIn: "signedIn",
  ghSignedIn: true,
};

const TestLayer = IssueAppToolsLive.pipe(
  Layer.provideMerge(IssueReporter.layer),
  Layer.provide(FakeGh),
  Layer.provide(Layer.succeed(LaunchChecksCache, { get: () => Effect.succeed(checks) })),
  Layer.provideMerge(RuntimeTestLayer),
);

const HOME = homedir();
const OS = `${osType()} ${release()} (${process.platform} ${process.arch})`;

/** A thread cast as `as` in `mode`, and its `report_issue` as the transport and Claude see it. */
const setup = (as: "plain" | "worker" | "orchestrator", mode: "default" | "bypassPermissions") =>
  Effect.gen(function* () {
    gh.calls = [];
    const runtimes = yield* ThreadRuntimes;
    const registry = yield* AppToolRegistry;
    const created = yield* runtimes.create({
      projectRoot: "/work/repo",
      checkout: { kind: "main", path: "/work/repo" },
    });
    yield* waitFor("idle", runtimes.status(created.id).pipe(Effect.map((s) => s === "idle")));
    const thread = yield* runtimes.updateThread(created.id, (t) => ({
      ...t,
      mode,
      ...(as === "worker"
        ? { spawnedBy: { threadId: "orch" as ThreadId, feature: "f" } }
        : as === "orchestrator"
          ? { role: "orchestrator" as const }
          : {}),
    }));
    const pick = (binding: "transport" | "session", name: string) => {
      const tools =
        binding === "transport" ? registry.forTransport(thread.id) : registry.forSession(thread.id);
      const tool = tools.find((t) => t.descriptor.name === name);
      if (tool === undefined) throw new Error(`no app tool ${name}`);
      return tool;
    };
    return { thread, runtimes, pick };
  });

/** Runs `call`, answers its card with `decision`, and returns the card and the call's outcome. */
const answered = <A>(
  threadId: ThreadId,
  call: Effect.Effect<A, AppToolError>,
  decision: "allow" | "deny",
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const fiber = yield* Effect.forkScoped(call);
    const card = yield* waitFor(
      "the approval card",
      store.listRequests(threadId).pipe(Effect.map((requests) => requests[0])),
    );
    yield* runtimes.respond(threadId, card.id, { kind: "approval", decision, scope: "once" });
    return { card, outcome: yield* Fiber.join(fiber).pipe(Effect.result) };
  });

const report = {
  kind: "bug" as const,
  area: "web" as const,
  title: "Terminal\nfreezes  on resize",
  body: `Resizing froze it. Log in ${HOME}/proj/out.log, token: hunter2abc and ghp_${"a".repeat(24)}.`,
};

/** A REST search item. */
const hit = (number: number, extra = {}) => ({
  number,
  title: `#${number}`,
  state: "open",
  html_url: `https://github.com/ANT1OFF/gram/issues/${number}`,
  ...extra,
});

describe("composing an issue", () => {
  it("maps kinds and areas to the repo's labels", () => {
    expect(issueLabels("bug")).toEqual(["bug"]);
    expect(issueLabels("feature", "desktop")).toEqual(["enhancement", "desktop"]);
    expect(issueLabels("question", "agents")).toEqual(["question", "agents"]);
  });

  it("redacts tokens, writes the home directory as ~ and drops hidden reordering", () => {
    const text = [
      `${HOME}/code/app.ts`,
      "Authorization: Bearer abcdefgh12345678",
      "http://127.0.0.1:4000/?token=s3cr3t",
      `sk-${"x".repeat(20)}`,
      "AKIAABCDEFGHIJKLMNOP",
      `api_key=${"k".repeat(12)}`,
      `a${String.fromCodePoint(0x202e)}b`,
    ].join("\n");
    const scrubbed = scrubIssueText(text, HOME);
    expect(scrubbed.split("\n")).toEqual([
      "~/code/app.ts",
      "Authorization: Bearer [redacted]",
      "http://127.0.0.1:4000/?token=[redacted]",
      "[redacted]",
      "[redacted]",
      "api_key=[redacted]",
      "ab",
    ]);
    expect(scrubIssueText("/Users/jo/x /Users/joanna/y", "/Users/jo")).toBe("~/x /Users/joanna/y");
  });

  it("puts the footer after a rule, naming the agent or the user, and nothing without it", () => {
    const agent = diagnosticsFooter({
      version: "0.6.0",
      os: "Darwin 25.0.0 (darwin arm64)",
      agent: { kind: "claude", version: "2.1.3", model: "claude-opus-5-5" },
      filer: "agent",
    });
    expect(agent).toBe(
      [
        "**Diagnostics**",
        "",
        "- Gram 0.6.0",
        "- Darwin 25.0.0 (darwin arm64)",
        "- Agent: claude 2.1.3, model claude-opus-5-5",
        "- Filed from Gram by an agent in a thread",
      ].join("\n"),
    );
    const user = composeIssue(
      { kind: "feature", title: "Dark  mode", body: "Please.\n" },
      { version: "0.6.0", os: "Linux 6 (linux x64)", filer: "user" },
      HOME,
    );
    expect(user).toMatchObject({
      repo: "ANT1OFF/gram",
      labels: ["enhancement"],
      title: "Dark mode",
      diagnostics:
        "**Diagnostics**\n\n- Gram 0.6.0\n- Linux 6 (linux x64)\n- Filed from Gram by the user",
    });
    expect(user.body).toBe(`Please.\n\n---\n\n${user.diagnostics}`);
    const url = new URL(user.newIssueUrl);
    expect(url.pathname).toBe("/ANT1OFF/gram/issues/new");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      title: "Dark mode",
      body: user.body,
      labels: "enhancement",
    });

    const bare = composeIssue({ kind: "bug", title: "t", body: "b" }, undefined, HOME);
    expect(bare.body).toBe("b");
    expect(bare.diagnostics).toBeUndefined();
  });

  it("reads search hits on the repo alone, leaving out pull requests", () => {
    const elsewhere = hit(5, { html_url: "https://github.com/EXAMPLE/secret/issues/5" });
    const out = JSON.stringify({
      items: [hit(1), hit(2, { pull_request: {} }), elsewhere, hit(3), hit(4)],
    });
    expect(parseIssueSearch(out, 2, "ANT1OFF/gram").map((h) => h.number)).toEqual([1, 3]);
    expect(parseIssueSearch("not json", 5, "ANT1OFF/gram")).toEqual([]);
  });

  it("takes the qualifiers that name other repos out of an agent's query", () => {
    expect(
      confineIssueQuery("crash repo:EXAMPLE/secret  org:EXAMPLE -user:x owner:y on resize"),
    ).toBe("crash on resize");
    expect(confineIssueQuery("error: label:bug")).toBe("error: label:bug");
  });
});

describe("report_issue", () => {
  it.effect("asks a plain thread in bypass mode on every call and posts what the card showed", () =>
    Effect.gen(function* () {
      const { thread, pick } = yield* setup("plain", "bypassPermissions");
      for (const binding of ["transport", "session"] as const) {
        gh.calls = [];
        gh.reply = ok({
          number: 160,
          html_url: "https://github.com/ANT1OFF/gram/issues/160",
        });
        const { card, outcome } = yield* answered(
          thread.id,
          pick(binding, "report_issue").run(report),
          "allow",
        );
        if (outcome._tag !== "Success") throw new Error(outcome.failure.message);
        expect(outcome.success).toEqual({
          number: 160,
          url: "https://github.com/ANT1OFF/gram/issues/160",
        });
        if (card.kind !== "approval") throw new Error("not an approval card");
        expect(card.scopes).toEqual(["once"]);
        expect(card.description).toBe(
          "File “Terminal freezes on resize” on ANT1OFF/gram (bug, web)",
        );
        const body = [
          `Resizing froze it. Log in ~/proj/out.log, token: [redacted] and [redacted].`,
          "",
          "---",
          "",
          "**Diagnostics**",
          "",
          "- Gram 0.0.0-dev",
          `- ${OS}`,
          `- Agent: claude 2.1.3, model ${thread.model.model}`,
          "- Filed from Gram by an agent in a thread",
        ].join("\n");
        expect(card.input).toEqual({
          repo: "ANT1OFF/gram",
          labels: ["bug", "web"],
          title: "Terminal freezes on resize",
          body,
        });
        expect(gh.calls).toHaveLength(1);
        expect(gh.calls[0]!.args).toEqual([
          "api",
          "repos/ANT1OFF/gram/issues",
          "--method",
          "POST",
          "--input",
          "-",
          "--include",
        ]);
        expect(JSON.parse(gh.calls[0]!.stdin!)).toEqual({
          title: "Terminal freezes on resize",
          body,
          labels: ["bug", "web"],
        });
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  for (const as of ["worker", "orchestrator"] as const) {
    it.effect(`asks ${as === "worker" ? "a worker" : "an orchestrator"} in bypass mode`, () =>
      Effect.gen(function* () {
        const { thread, pick } = yield* setup(as, "bypassPermissions");
        const { card, outcome } = yield* answered(
          thread.id,
          pick("session", "report_issue").run({ ...report, includeDiagnostics: false }),
          "deny",
        );
        expect(card).toMatchObject({ scopes: ["once"] });
        expect(outcome).toMatchObject({ _tag: "Failure", failure: { approvalRequired: true } });
        expect(gh.calls).toEqual([]);
      }).pipe(Effect.provide(TestLayer)),
    );
  }

  it.effect("leaves the footer out without diagnostics", () =>
    Effect.gen(function* () {
      const { thread, pick } = yield* setup("plain", "default");
      const { card } = yield* answered(
        thread.id,
        pick("transport", "report_issue").run({
          kind: "question",
          title: "Why?",
          body: "Just curious.",
          includeDiagnostics: false,
        }),
        "deny",
      );
      expect(card).toMatchObject({
        input: { labels: ["question"], title: "Why?", body: "Just curious." },
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails with gh's error and the link to file it by hand", () =>
    Effect.gen(function* () {
      const { thread, pick } = yield* setup("plain", "default");
      gh.reply = { status: 1, stdout: "", stderr: "HTTP 404: Not Found", truncated: false };
      const { outcome } = yield* answered(
        thread.id,
        pick("transport", "report_issue").run(report),
        "allow",
      );
      if (outcome._tag !== "Failure") throw new Error("the call succeeded");
      expect(outcome.failure.message).toMatch(
        /^HTTP 404: Not Found\. The user can file it by hand from https:\/\/github\.com\/ANT1OFF\/gram\/issues\/new\?title=Terminal\+freezes/,
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps the card whatever the tool's own answer or the full-autonomy delegation", () =>
    Effect.gen(function* () {
      const asked: Array<[string, unknown, boolean | undefined]> = [];
      const gate = {
        approve: (
          _threadId: ThreadId,
          descriptor: AppToolDescriptor,
          input: unknown,
          _description?: string,
          forced?: boolean,
        ) => Effect.sync(() => void asked.push([descriptor.name, input, forced])),
      };
      const tool = defineAppTool({
        descriptor: { name: "always", class: "outward", description: "" },
        input: Schema.Struct({ n: Schema.Number }),
        alwaysAsks: true,
        needsApproval: () => Effect.succeed(false),
        delegatedAtFullAutonomy: () => Effect.succeed(true),
        cardDetails: ({ n }) => ({ shown: n * 2 }),
        handle: () => Effect.void,
      });
      const [bound] = bindAppTools([tool], "t1" as ThreadId, gate);
      expect(bound!.needsApproval).toBeUndefined();
      expect(bound!.delegatedAtFullAutonomy).toBeUndefined();
      yield* bound!.run({ n: 2 });
      expect(asked).toEqual([["always", { shown: 4 }, true]]);
    }),
  );
});

describe("search_issues", () => {
  it.effect("searches the repo's open issues over REST without a card", () =>
    Effect.gen(function* () {
      const { thread, pick } = yield* setup("plain", "default");
      gh.reply = ok({
        items: [
          {
            number: 12,
            title: "Terminal freezes",
            state: "open",
            html_url: "https://github.com/ANT1OFF/gram/issues/12",
          },
        ],
      });
      const hits = yield* pick("transport", "search_issues").run({
        query: "terminal freeze repo:EXAMPLE/secret",
      });
      expect(hits).toEqual({
        issues: [
          {
            number: 12,
            title: "Terminal freezes",
            state: "open",
            url: "https://github.com/ANT1OFF/gram/issues/12",
          },
        ],
      });
      expect(gh.calls[0]!.args).toEqual([
        "api",
        "search/issues",
        "--method",
        "GET",
        "-f",
        "q=repo:ANT1OFF/gram is:issue is:open terminal freeze",
        "-f",
        "per_page=10",
        "--include",
      ]);
      expect(yield* (yield* ThreadStore).listRequests(thread.id)).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("the form's RPCs", () => {
  it.effect("preview what file posts, as the user and naming the thread's agent", () =>
    Effect.gen(function* () {
      const { thread } = yield* setup("plain", "default");
      const handlers = yield* issueHandlers;
      const draft = {
        ...report,
        kind: "feature" as const,
        includeDiagnostics: true,
        threadId: thread.id,
      };
      const preview = yield* handlers["issues.preview"](draft);
      expect(preview.labels).toEqual(["enhancement", "web"]);
      expect(preview.diagnostics).toContain("- Filed from Gram by the user");
      expect(preview.diagnostics).toContain(`- Agent: claude 2.1.3`);

      gh.reply = ok({ number: 9, html_url: "https://github.com/ANT1OFF/gram/issues/9" });
      expect(yield* handlers["issues.file"](draft)).toEqual({
        number: 9,
        url: "https://github.com/ANT1OFF/gram/issues/9",
      });
      expect(JSON.parse(gh.calls[0]!.stdin!)).toEqual({
        title: preview.title,
        body: preview.body,
        labels: preview.labels,
      });

      gh.reply = { status: 4, stdout: "", stderr: "gh auth login", truncated: false };
      const error = yield* handlers["issues.file"](draft).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "GitError", message: "gh auth login" });
    }).pipe(Effect.provide(TestLayer)),
  );
});
