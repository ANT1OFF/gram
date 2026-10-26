import type { RequestId, ThreadId, WorkerQuestion, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { asksOf, workerAskOf, workerQuestionId } from "./ask-model";
import {
  featureQuestions,
  forwardedQuestions,
  memoryQuestionCard,
  questionOutcome,
  workerQuestionCard,
} from "./question-card-model";

// Worker questions (docs/design/worker-questions.md) as the stack, the band and the cards see them.

const W1 = "w1" as WorkspaceId;

const asked = (id: string, more: Partial<WorkerQuestion> = {}): WorkerQuestion => ({
  id,
  workspaceId: W1,
  threadId: "t-cart" as ThreadId,
  feature: "cart",
  title: "Cart API",
  question: "Should a deleted cart answer 404 or 410?",
  askedAt: 1_000,
  triageUntil: 601_000,
  stage: "forwarded",
  forwardedAt: 2_000,
  forwardedBy: "orchestrator",
  ...more,
});

const choices = {
  options: [{ label: "404" }, { label: "410", description: "Gone" }],
  recommended: "410",
};

describe("a worker's question as an ask", () => {
  it("leads with the worker's words exactly and puts its pick first", () => {
    const ask = workerAskOf(W1, asked("WQ1", { ...choices, note: "Affects Cart client too." }));
    expect(ask).toMatchObject({
      key: workerQuestionId(W1, asked("WQ1")),
      ids: ["worker-question:w1:WQ1"],
      icon: "question",
      lead: "Should a deleted cart answer 404 or 410?",
      context: "cart · Cart API",
      description: "Orchestrator: Affects Cart client too.",
    });
    expect(ask.options.map((option) => [option.label, option.recommended])).toEqual([
      ["410", true],
      ["404", undefined],
    ]);
    expect(ask.options[0]?.action).toEqual({ kind: "worker", answer: "410" });
  });

  it("takes free text when it offers no choices, and says the worker's own recommendation", () => {
    const ask = workerAskOf(
      W1,
      asked("WQ2", { context: "Clients cache 404s.", recommended: "410, it's gone" }),
    );
    expect(ask.options).toEqual([]);
    expect(ask.freeForm).toEqual({ question: "Should a deleted cart answer 404 or 410?" });
    expect(ask.description).toBe("Clients cache 404s.\nRecommends: 410, it's gone");
  });

  it("is in a workspace's asks only once forwarded, and not once answered here", () => {
    const groups: never[] = [];
    const questions = [
      asked("WQ1"),
      (({ forwardedAt: _at, forwardedBy: _by, ...rest }) => rest)(
        asked("WQ2", { stage: "triage" }),
      ),
      asked("WQ3", { stage: "answered", closedBy: "user", answer: "410" }),
    ];
    const keys = (hidden = new Set<string>()) =>
      asksOf({ groups, workerQuestions: questions, workspaceId: W1, hidden }).map((a) => a.key);
    expect(keys()).toEqual(["worker-question:w1:WQ1"]);
    expect(keys(new Set(["worker-question:w1:WQ1"]))).toEqual([]);
  });

  it("comes after the orchestrator's own questions and before the workers' requests", () => {
    const groups = [
      {
        key: "g",
        entries: [
          {
            threadId: "t-docs" as ThreadId,
            title: "Docs",
            feature: "docs",
            request: {
              kind: "question" as const,
              id: "r1" as RequestId,
              questions: [
                {
                  question: "uv only?",
                  header: "",
                  multiSelect: false,
                  options: [{ label: "yes", description: "" }],
                },
              ],
            },
          },
        ],
      },
    ] as const;
    const asks = asksOf({
      groups: [{ key: groups[0].key, entries: [groups[0].entries[0]] }],
      questions: [{ id: "Q1", text: "Ship it?", detail: undefined, open: true }],
      workerQuestions: [asked("WQ1")],
      workspaceId: W1,
    });
    expect(asks.map((ask) => ask.key)).toEqual(["memory:w1:Q1", "worker-question:w1:WQ1", "r1"]);
  });
});

describe("the question card", () => {
  it("draws both kinds from one model; only a worker's names its asker and can be dismissed", () => {
    expect(
      memoryQuestionCard({ id: "Q1", text: "Ship it?", detail: undefined, open: true }),
    ).toEqual({
      key: "Q1",
      id: "Q1",
      text: "Ship it?",
      detail: undefined,
      options: [],
      multiSelect: false,
      recommended: undefined,
      to: "orchestrator",
      dismissable: false,
    });
    const card = workerQuestionCard(asked("WQ1", { ...choices, note: "I'd pick 410." }));
    expect(card).toMatchObject({
      id: "WQ1",
      text: "Should a deleted cart answer 404 or 410?",
      recommended: "410",
      recommendation: undefined,
      asker: { threadId: "t-cart", title: "Cart API", feature: "cart" },
      note: "I'd pick 410.",
      to: "worker",
      dismissable: true,
    });
    expect(card.status).toMatch(/^Forwarded to you · \d\d:\d\d$/);
    expect(workerQuestionCard(asked("WQ2", { recommended: "410" })).recommendation).toBe("410");
  });

  it("says what a closed question came to, and on what grounds", () => {
    expect(
      questionOutcome(
        asked("WQ1", {
          stage: "answered",
          closedBy: "orchestrator",
          answer: "410",
          source: "the brief",
        }),
      ),
    ).toBe("410 (settled by the brief)");
    expect(
      questionOutcome(asked("WQ1", { stage: "answered", closedBy: "user", answer: "404" })),
    ).toBe("404");
    expect(questionOutcome(asked("WQ1", { stage: "dismissed", reason: "Not now" }))).toBe(
      "Not now",
    );
    expect(questionOutcome(asked("WQ1"))).toBeUndefined();
  });

  it("picks the forwarded ones for the band and a feature's for its sheet", () => {
    const ledger = {
      questions: [
        asked("WQ1"),
        asked("WQ2", { stage: "triage" }),
        asked("WQ3", { feature: "search" }),
      ],
    };
    expect(forwardedQuestions(ledger).map((q) => q.id)).toEqual(["WQ1", "WQ3"]);
    expect(featureQuestions(ledger, "cart").map((q) => q.id)).toEqual(["WQ1", "WQ2"]);
    expect(forwardedQuestions(undefined)).toEqual([]);
  });
});
