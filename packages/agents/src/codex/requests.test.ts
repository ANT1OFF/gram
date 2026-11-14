import { describe, expect, it } from "vitest";
import { makeCodexMapper } from "./mapper.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";
import { gateVerdict, responseFor, toPendingRequest } from "./requests.ts";
import { codexFixture, serverMessages } from "./testing.ts";
import { MessageId } from "@gram/contracts";

const firstRequest = (name: string) => {
  const messages = serverMessages(codexFixture(name));
  const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("m1") });
  for (const message of messages) {
    if ("id" in message) return { request: message as ServerRequest, mapper };
    mapper.map(message as ServerNotification);
  }
  throw new Error(`${name} has no server request`);
};

describe("toPendingRequest and responseFor", () => {
  it("offers a command approval once or always, and answers with Codex decisions", () => {
    const { request, mapper } = firstRequest("cx02-approval");
    expect(toPendingRequest(request, mapper.changes)).toMatchObject({
      kind: "approval",
      id: "codex-0",
      toolUseId: "call_1",
      toolName: "Bash",
      input: { command: "echo hello", cwd: "$CWD" },
      description: "Print a greeting",
      scopes: ["once", "always"],
    });
    expect(responseFor(request, { kind: "approval", decision: "allow", scope: "once" })).toEqual({
      decision: "accept",
    });
    expect(responseFor(request, { kind: "approval", decision: "allow", scope: "always" })).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo", "hello"] } },
    });
    // `decline` isn't among this request's decisions.
    expect(responseFor(request, { kind: "approval", decision: "deny", scope: "once" })).toEqual({
      decision: "cancel",
    });
  });

  it("shows a file change's patches and answers once, for the session or declines", () => {
    const { request, mapper } = firstRequest("cx03-file-change");
    expect(toPendingRequest(request, mapper.changes)).toMatchObject({
      kind: "approval",
      toolName: "Edit",
      input: {
        file_path: "$CWD/hello.txt",
        changes: [{ path: "$CWD/hello.txt", kind: { type: "add" }, diff: "hello\n" }],
      },
      scopes: ["once", "session"],
    });
    expect(responseFor(request, { kind: "approval", decision: "allow", scope: "session" })).toEqual(
      {
        decision: "acceptForSession",
      },
    );
    expect(responseFor(request, { kind: "approval", decision: "deny", scope: "once" })).toEqual({
      decision: "decline",
    });
  });

  it("gives the outward gate's verdict, once-only card and decline from the command alone", () => {
    const { request, mapper } = firstRequest("cx02-approval");
    const push = {
      ...request,
      params: {
        ...request.params,
        command: "/bin/zsh -lc 'git add -A && git push'",
        commandActions: [{ type: "unknown", command: "git add -A && git push" }],
        proposedExecpolicyAmendment: ["git", "push"],
      },
    } as ServerRequest;
    const patch = firstRequest("cx03-file-change").request;
    const question = firstRequest("cx07-plan-question").request;

    expect([request, push, patch, question].map((r) => gateVerdict(r, true))).toEqual([
      "accept",
      "askOnce",
      "accept",
      "pass",
    ]);
    // Outside bypass the adapter answers nothing itself, but a push is still once-only.
    expect([request, push, patch, question].map((r) => gateVerdict(r, false))).toEqual([
      "pass",
      "askOnce",
      "pass",
      "pass",
    ]);
    // Only the parsed action names the push: either reading is enough.
    expect(
      gateVerdict(
        { ...push, params: { ...push.params, command: "/bin/zsh -lc ..." } } as never,
        true,
      ),
    ).toBe("askOnce");

    expect(toPendingRequest(push, mapper.changes, true)).toMatchObject({
      suggestions: [],
      scopes: ["once"],
    });
    expect(toPendingRequest(push, mapper.changes)).toMatchObject({ scopes: ["once", "always"] });
    expect(toPendingRequest(request, mapper.changes, true)).toMatchObject({
      scopes: ["once", "always"],
    });

    const always = { kind: "approval", decision: "allow", scope: "always" } as const;
    const no = { kind: "approval", decision: "deny", scope: "once" } as const;
    expect(responseFor(push, always, true)).toEqual({ decision: "accept" });
    expect(responseFor(push, always)).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "push"] } },
    });
    // `decline` isn't offered, and a gated session sends it all the same: `cancel` ends the turn.
    expect(responseFor(push, no, true)).toEqual({ decision: "decline" });
    expect(responseFor(request, no, true)).toEqual({ decision: "decline" });
    expect(responseFor(push, no)).toEqual({ decision: "cancel" });
  });

  it("at irreversible, asks once about what can't be taken back and lets a push be an ordinary command", () => {
    const { request, mapper } = firstRequest("cx02-approval");
    const running = (command: string): ServerRequest =>
      ({
        ...request,
        params: {
          ...request.params,
          command: `/bin/zsh -lc '${command}'`,
          commandActions: [{ type: "unknown", command }],
          proposedExecpolicyAmendment: ["git", "push"],
        },
      }) as ServerRequest;
    const push = running("git add -A && git push");
    const forced = running("git push --force-with-lease origin feature");
    const merge = running("gh pr merge 3 --squash");
    const commands = [request, push, running("gh pr create --fill"), forced, merge];

    expect(commands.map((r) => gateVerdict(r, true, "irreversible"))).toEqual([
      "accept",
      "accept",
      "accept",
      "askOnce",
      "askOnce",
    ]);
    expect(commands.map((r) => gateVerdict(r, false, "irreversible"))).toEqual([
      "pass",
      "pass",
      "pass",
      "askOnce",
      "askOnce",
    ]);
    // `all` is what a gate with no level named asks at, and what `true` spells.
    expect(commands.map((r) => gateVerdict(r, true, "all"))).toEqual(
      commands.map((r) => gateVerdict(r, true)),
    );
    expect(toPendingRequest(push, mapper.changes, "all")).toEqual(
      toPendingRequest(push, mapper.changes, true),
    );

    expect(toPendingRequest(forced, mapper.changes, "irreversible")).toMatchObject({
      scopes: ["once"],
    });
    expect(toPendingRequest(merge, mapper.changes, "irreversible")).toMatchObject({
      scopes: ["once"],
    });
    // The push's own card is the mode's, but "always" would write an allow rule on `git push`,
    // which is a prefix of the forced push.
    expect(toPendingRequest(push, mapper.changes, "irreversible")).toMatchObject({
      scopes: ["once"],
    });
    expect(toPendingRequest(request, mapper.changes, "irreversible")).toMatchObject({
      scopes: ["once", "always"],
    });

    const always = { kind: "approval", decision: "allow", scope: "always" } as const;
    const no = { kind: "approval", decision: "deny", scope: "once" } as const;
    expect(responseFor(forced, always, "irreversible")).toEqual({ decision: "accept" });
    expect(responseFor(push, always, "irreversible")).toEqual({ decision: "accept" });
    expect(responseFor(push, always, "all")).toEqual(responseFor(push, always, true));
    expect(responseFor(push, no, "irreversible")).toEqual({ decision: "decline" });
  });

  it("turns a plan-mode question into a card and answers by question id", () => {
    const { request, mapper } = firstRequest("cx07-plan-question");
    expect(toPendingRequest(request, mapper.changes)).toEqual({
      kind: "question",
      id: "codex-0",
      toolUseId: "call_4",
      questions: [
        {
          question: "What should the cleanup cover?",
          header: "Scope",
          multiSelect: false,
          options: [
            { label: "Tests only (Recommended)", description: "Only the test suite." },
            { label: "Everything", description: "The whole repository." },
          ],
        },
      ],
    });
    expect(
      responseFor(request, {
        kind: "question",
        answers: { "What should the cleanup cover?": ["Tests only (Recommended)"] },
      }),
    ).toEqual({ answers: { scope: { answers: ["Tests only (Recommended)"] } } });
  });
});

const prompt = (params: Record<string, unknown>): ServerRequest =>
  ({
    id: 7,
    method: "mcpServer/elicitation/request",
    params: { threadId: "t1", turnId: "turn1", serverName: "cua_repl", ...params },
  }) as unknown as ServerRequest;
const allow = (scope: "once" | "session" | "always") =>
  ({ kind: "approval", decision: "allow", scope }) as const;

describe("an MCP server's permission prompt", () => {
  const deny = { kind: "approval", decision: "deny", scope: "once" } as const;
  const declined = { action: "decline", content: null, _meta: null };

  const appAccess = prompt({
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    _meta: { persist: ["session", "always"] },
    requestedSchema: { type: "object", properties: {} },
  });

  it("is an approval card naming the app, with the lifetimes the server offers", () => {
    expect(toPendingRequest(appAccess, () => undefined)).toEqual({
      kind: "approval",
      id: "codex-7",
      toolName: "mcp__cua_repl__elicitation",
      displayName: "Safari",
      input: { server: "cua_repl", app: "Safari" },
      description: "Allow ChatGPT to use Safari?",
      suggestions: [],
      scopes: ["once", "session", "always"],
    });
  });

  it("answers with the MCP action, and says how long a yes lasts", () => {
    expect(responseFor(appAccess, allow("once"))).toEqual({
      action: "accept",
      content: {},
      _meta: null,
    });
    expect(responseFor(appAccess, allow("session"))).toEqual({
      action: "accept",
      content: {},
      _meta: { persist: "session" },
    });
    expect(responseFor(appAccess, allow("always"))).toEqual({
      action: "accept",
      content: {},
      _meta: { persist: "always" },
    });
    expect(responseFor(appAccess, deny)).toEqual(declined);
  });

  it("offers only the one use where the server names no lifetime, and under a gate", () => {
    const bare = prompt({
      mode: "form",
      message: "Allow this?",
      _meta: null,
      requestedSchema: { type: "object", properties: {} },
    });
    expect(toPendingRequest(bare, () => undefined)).toMatchObject({
      displayName: "cua_repl",
      input: { server: "cua_repl" },
      scopes: ["once"],
    });
    expect(toPendingRequest(appAccess, () => undefined, "all")).toMatchObject({ scopes: ["once"] });
    // A longer grant the card didn't offer is the one use, never more.
    expect(responseFor(bare, allow("always"))).toEqual({
      action: "accept",
      content: {},
      _meta: null,
    });
    expect(responseFor(appAccess, allow("session"), "all")).toEqual({
      action: "accept",
      content: {},
      _meta: null,
    });
  });

  it("offers only the one use when the browser was lent to ask each time", () => {
    expect(toPendingRequest(appAccess, () => undefined, false, true)).toMatchObject({
      scopes: ["once"],
    });
    expect(responseFor(appAccess, allow("always"), false, true)).toEqual({
      action: "accept",
      content: {},
      _meta: null,
    });
  });

  it("fills a form that only asks how long the grant lasts", () => {
    const choice = prompt({
      mode: "openai/form",
      message: "Allow ChatGPT to use Notes?",
      _meta: { app_name: "Notes" },
      requestedSchema: {
        type: "object",
        properties: {
          approval: { type: "string", enum: ["allow_once", "allow_for_session"] },
          remember: { type: "boolean", title: "Always allow" },
        },
        required: ["approval"],
      },
    });
    expect(toPendingRequest(choice, () => undefined)).toMatchObject({
      displayName: "Notes",
      // Its choice has no word for always, so the checkbox alone can't be answered.
      scopes: ["once", "session"],
    });
    expect(responseFor(choice, allow("once"))).toEqual({
      action: "accept",
      content: { approval: "allow_once", remember: false },
      _meta: null,
    });
    expect(responseFor(choice, allow("session"))).toEqual({
      action: "accept",
      content: { approval: "allow_for_session", remember: false },
      _meta: { persist: "session" },
    });
  });

  it("declines a prompt a yes or no can't answer, in the MCP shape", () => {
    const form = prompt({
      mode: "form",
      message: "Which account?",
      _meta: null,
      requestedSchema: {
        type: "object",
        properties: { account: { type: "string" } },
        required: ["account"],
      },
    });
    const link = prompt({
      mode: "url",
      message: "Sign in",
      _meta: null,
      url: "https://example.com/login",
      elicitationId: "e1",
    });
    for (const request of [form, link]) {
      expect(toPendingRequest(request, () => undefined)).toBeUndefined();
      expect(responseFor(request, deny)).toEqual(declined);
      expect(responseFor(request, allow("once"))).toEqual(declined);
    }
  });
});
