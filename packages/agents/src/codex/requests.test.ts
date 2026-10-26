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
