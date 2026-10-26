import { readFileSync } from "node:fs";
import type { ApprovalRequest, PlanRequest, QuestionRequest } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import {
  isOutwardBash,
  outwardBashKind,
  resolveRequest,
  toPendingRequest,
  type CanUseToolOptions,
} from "./permissions.ts";

interface Call {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly opts: Omit<CanUseToolOptions, "signal">;
}

/** The first `canUseTool` call the spike recorded in a fixture. */
const recordedCall = (name: string): Call => {
  const line = readFileSync(new URL(`../../fixtures/claude/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .find((l) => l.includes('"note": "canUseTool"') || l.includes('"note":"canUseTool"'));
  return (JSON.parse(line ?? "{}") as { data: Call }).data;
};

const approval = () => {
  const call = recordedCall("p05-approvals");
  return {
    call,
    request: toPendingRequest(call.toolName, call.input, call.opts) as ApprovalRequest,
  };
};

describe("toPendingRequest", () => {
  it("builds an approval card from displayName, input and suggestions", () => {
    expect(approval().request).toEqual({
      kind: "approval",
      id: "00000000-0000-4000-8000-000000000233",
      toolUseId: "toolu_fixture_0003",
      toolName: "Bash",
      displayName: "Bash",
      input: { command: "echo hello > hi.txt", description: 'Create a file with "hello" content' },
      description: 'Create a file with "hello" content',
      blockedPath: "/synthetic/project/hi.txt",
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "echo hello *" }],
          behavior: "allow",
          destination: "localSettings",
        },
        {
          type: "addDirectories",
          directories: ["/synthetic/project"],
          destination: "session",
        },
      ],
      scopes: ["once", "session", "always"],
    });
  });

  it("drops suggestions when always-allow is suppressed", () => {
    const { call } = approval();
    expect(toPendingRequest(call.toolName, call.input, call.opts, true)).toMatchObject({
      suggestions: [],
      scopes: ["once"],
    });
    expect(
      toPendingRequest(call.toolName, call.input, { ...call.opts, suppressAlwaysAllowRule: true }),
    ).toMatchObject({ suggestions: [], scopes: ["once"] });
  });

  it("turns AskUserQuestion into a question card", () => {
    const call = recordedCall("p07-ask-user-question");
    expect(toPendingRequest(call.toolName, call.input, call.opts)).toEqual({
      kind: "question",
      id: "00000000-0000-4000-8000-000000000609",
      toolUseId: "toolu_fixture_0020",
      questions: [
        {
          question: "Which file name should I use?",
          header: "File name",
          multiSelect: false,
          options: [
            { label: "alpha.txt", description: "Create alpha.txt" },
            { label: "beta.txt", description: "Create beta.txt" },
          ],
        },
      ],
    });
  });

  it("turns ExitPlanMode into a plan card", () => {
    const call = recordedCall("p06-exit-plan-mode");
    expect(toPendingRequest(call.toolName, call.input, call.opts)).toEqual({
      kind: "plan",
      id: "00000000-0000-4000-8000-000000000572",
      toolUseId: "toolu_fixture_0018",
      plan: '# Plan\n\nCreate plan.txt in the current directory with the content "hi".\n',
      planFilePath: "/synthetic/home/.claude/plans/fixture-plan.md",
    });
  });
});

describe("resolveRequest", () => {
  const { call, request } = approval();
  const allow = (
    scope: "once" | "session" | "always",
    settingSources?: Array<"user" | "project" | "local">,
  ) =>
    resolveRequest(
      request,
      call.input,
      { kind: "approval", decision: "allow", scope },
      settingSources,
    );

  it("allows once without persisting anything", () => {
    expect(allow("once")).toEqual({
      result: { behavior: "allow", updatedInput: call.input, toolUseID: request.toolUseId },
    });
  });

  it("allows for the session by rewriting suggestions to the session destination", () => {
    expect(allow("session").result).toMatchObject({
      updatedPermissions: [
        { type: "addRules", destination: "session" },
        { type: "addDirectories", destination: "session" },
      ],
    });
  });

  it("allows always with the suggestions as-is while local settings load", () => {
    expect(allow("always").result).toMatchObject({
      updatedPermissions: [
        { type: "addRules", destination: "localSettings" },
        { type: "addDirectories", destination: "session" },
      ],
    });
    expect(allow("always", ["user", "project", "local"]).result).toMatchObject({
      updatedPermissions: [{ destination: "localSettings" }, { destination: "session" }],
    });
  });

  it("adds session copies for always when local settings aren't loaded", () => {
    expect(allow("always", []).result).toMatchObject({
      updatedPermissions: [
        { type: "addRules", destination: "localSettings" },
        { type: "addDirectories", destination: "session" },
        {
          type: "addRules",
          destination: "session",
          rules: [{ toolName: "Bash", ruleContent: "echo hello *" }],
        },
      ],
    });
  });

  it("denies with the user's message or a default", () => {
    const deny = (message?: string) =>
      resolveRequest(
        request,
        call.input,
        { kind: "approval", decision: "deny", scope: "once", ...(message ? { message } : {}) },
        undefined,
      ).result;
    expect(deny("use rg")).toEqual({
      behavior: "deny",
      message: "use rg",
      toolUseID: request.toolUseId,
    });
    expect(deny()).toMatchObject({ behavior: "deny", message: "The user denied this tool call." });
  });

  it("writes question answers keyed by question text, comma-joining multi-select", () => {
    const question: QuestionRequest = {
      kind: "question",
      id: request.id,
      questions: [
        { question: "Which features?", header: "Features", multiSelect: true, options: [] },
        { question: "Which name?", header: "Name", multiSelect: false, options: [] },
        { question: "Skipped?", header: "Skip", multiSelect: false, options: [] },
      ],
    };
    const input = { questions: [] };
    expect(
      resolveRequest(
        question,
        input,
        {
          kind: "question",
          answers: { "Which features?": ["Auth", "Billing"], "Which name?": ["beta.txt"] },
        },
        undefined,
      ),
    ).toEqual({
      result: {
        behavior: "allow",
        updatedInput: {
          questions: [],
          answers: { "Which features?": "Auth, Billing", "Which name?": "beta.txt" },
        },
      },
    });
  });

  it("switches mode on plan approval and denies on rejection", () => {
    const plan: PlanRequest = { kind: "plan", id: request.id, toolUseId: "t", plan: "# Plan" };
    const input = { plan: "# Plan" };
    expect(resolveRequest(plan, input, { kind: "plan", decision: "approve" }, undefined)).toEqual({
      result: { behavior: "allow", updatedInput: input, toolUseID: "t" },
      setMode: "acceptEdits",
    });
    expect(
      resolveRequest(plan, input, { kind: "plan", decision: "approve", mode: "auto" }, undefined)
        .setMode,
    ).toBe("auto");
    expect(
      resolveRequest(
        plan,
        input,
        { kind: "plan", decision: "reject", message: "smaller" },
        undefined,
      ),
    ).toEqual({
      result: { behavior: "deny", message: "smaller", toolUseID: "t" },
    });
  });

  it("denies a mismatched answer rather than approving", () => {
    expect(
      resolveRequest(request, call.input, { kind: "plan", decision: "approve" }, undefined).result
        .behavior,
    ).toBe("deny");
  });
});

describe("isOutwardBash", () => {
  it("is a Bash call whose command pushes or acts on a PR, and nothing else", () => {
    expect(isOutwardBash("Bash", { command: "cd x && git push" })).toBe(true);
    expect(isOutwardBash("Bash", { command: "gh pr merge 3 --squash" })).toBe(true);
    expect(isOutwardBash("Bash", { command: "git status" })).toBe(false);
    expect(isOutwardBash("Bash", { command: 7 })).toBe(false);
    expect(isOutwardBash("Bash", undefined)).toBe(false);
    expect(isOutwardBash("Write", { command: "git push" })).toBe(false);
  });

  it("knows a push from what can't be taken back", () => {
    expect(outwardBashKind("Bash", { command: "cd x && git push" })).toBe("publish");
    expect(outwardBashKind("Bash", { command: "git push -f" })).toBe("irreversible");
    expect(outwardBashKind("Bash", { command: "gh pr merge 3" })).toBe("irreversible");
    expect(outwardBashKind("Bash", { command: "git status" })).toBeUndefined();
    expect(outwardBashKind("Write", { command: "git push -f" })).toBeUndefined();
  });
});
