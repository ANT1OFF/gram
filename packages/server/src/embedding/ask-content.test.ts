import { describe, expect, it } from "vitest";
import type { PendingRequest, RequestId } from "@gram/contracts";
import { ASK_PLAN_MAX_CHARS, askContent } from "./ask-content.ts";
import {
  ASK_OPTION_LABEL_MAX_CHARS,
  ASK_QUESTION_MAX_CHARS,
  ASK_QUESTIONS_MAX,
} from "./ask-limits.ts";

const id = "req-1" as RequestId;
const question = {
  question: "Which close should the comparison run on?",
  header: "Close",
  options: [
    { label: "October", description: "The last full close.", preview: "never sent" },
    { label: "Both", description: "" },
  ],
  multiSelect: false,
};
const asking = (questions: ReadonlyArray<typeof question>): PendingRequest => ({
  kind: "question",
  id,
  questions,
});

describe("what an ask's opening carries for a receiver to answer it", () => {
  it("carries a question's text, choices and whether several may be picked, never a preview", () => {
    expect(askContent(asking([question]))).toEqual({
      questions: [
        {
          question: question.question,
          header: "Close",
          options: [{ label: "October", description: "The last full close." }, { label: "Both" }],
          multiSelect: false,
        },
      ],
    });
  });

  it("carries none of a question ask that doesn't fit whole, since an answer is keyed by its text", () => {
    const long = "q".repeat(ASK_QUESTION_MAX_CHARS + 1);
    expect(askContent(asking([{ ...question, question: long }]))).toEqual({});
    expect(
      askContent(
        asking([
          {
            ...question,
            options: [{ label: "l".repeat(ASK_OPTION_LABEL_MAX_CHARS + 1), description: "" }],
          },
        ]),
      ),
    ).toEqual({});
    expect(
      askContent(asking(Array.from({ length: ASK_QUESTIONS_MAX + 1 }, () => question))),
    ).toEqual({});
    expect(askContent(asking([]))).toEqual({});
  });

  it("carries a plan, cut and marked when it is long", () => {
    expect(askContent({ kind: "plan", id, plan: "1. Do it." })).toEqual({ plan: "1. Do it." });
    const cut = askContent({ kind: "plan", id, plan: "p".repeat(ASK_PLAN_MAX_CHARS + 5) });
    expect(cut.plan).toHaveLength(ASK_PLAN_MAX_CHARS);
    expect(cut.planTruncated).toBe(true);
  });

  it("carries an approval's exact command, the model's words for it and why it asks", () => {
    const approval = {
      kind: "approval" as const,
      id,
      toolName: "Bash",
      displayName: "Bash",
      input: { command: "bun run export --dry" },
      description: " Check the export before switching it ",
      decisionReason: "Bash commands ask first in this workspace",
      suggestions: [],
    };
    expect(askContent(approval)).toEqual({
      command: "bun run export --dry",
      description: "Check the export before switching it",
      reason: "Bash commands ask first in this workspace",
    });
    // A call with no command, and no words of its own, carries nothing.
    const { decisionReason: _reason, ...unexplained } = approval;
    expect(askContent({ ...unexplained, input: { file_path: "a.ts" }, description: "" })).toEqual(
      {},
    );
    // A hidden character in a command is shown, never passed on unseen.
    expect(askContent({ ...approval, input: { command: "ls\u202e" } }).command).not.toContain(
      "\u202e",
    );
    expect(
      askContent({ ...approval, input: { command: "c".repeat(20_000) } }).command,
    ).toHaveLength(10_000);
  });
});
