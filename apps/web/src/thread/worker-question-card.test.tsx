// @vitest-environment happy-dom
import type {
  AnswerWorkerQuestionInput,
  OrchestratorLedger,
  ThreadId,
  WorkerQuestion,
  WorkspaceId,
} from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Api } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";

import { WorkerQuestionCard } from "./worker-question-card";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: unknown }) => children,
  useNavigate: () => vi.fn(),
}));

// A worker's question card in a transcript is drawn once, as the question was then (the
// orchestrator's never again), so it follows the workspace's live ledger: an answer given anywhere
// else shows on it, and Update answer changes an answer without overwriting a newer one.

afterEach(cleanup);

const workspaceId = "ws-1" as WorkspaceId;
const workerId = "t-worker" as ThreadId;
const orchestratorId = "t-orch" as ThreadId;

const forwarded: WorkerQuestion = {
  id: "WQ7",
  workspaceId,
  threadId: workerId,
  feature: "tenant-kubectl",
  title: "Tenant kubectl MCP server",
  question: "Which role does a tenant's kubectl get?",
  options: [
    { label: "Member", description: "Read and exec in its namespaces" },
    { label: "Admin", description: "Everything in its namespaces" },
  ],
  recommended: "Member",
  askedAt: Date.parse("2026-11-22T09:00:00"),
  triageUntil: Date.parse("2026-11-22T09:10:00"),
  stage: "forwarded",
  forwardedAt: Date.parse("2026-11-22T09:02:00"),
  forwardedBy: "orchestrator",
};

const answered = (answer: string, at: string, more: Partial<WorkerQuestion> = {}) =>
  ({
    ...forwarded,
    stage: "answered",
    answer,
    closedBy: "user",
    closedAt: Date.parse(`2026-11-22T${at}:00`),
    ...more,
  }) satisfies WorkerQuestion;

const ledger = (question: WorkerQuestion) =>
  ({ workspaceId, features: [], questions: [question] }) as unknown as OrchestratorLedger;

const notYet = (_: WorkerQuestion): void => undefined;

/** A fake api whose ledger stream the test pushes, one ledger at a time. */
function fakeApi(first: WorkerQuestion) {
  let push = notYet;
  let latest = first;
  const answers: AnswerWorkerQuestionInput[] = [];
  const api = {
    orchestratorLedger: async () => ledger(latest),
    async *watchLedger(_: WorkspaceId, signal: AbortSignal) {
      yield ledger(latest);
      while (!signal.aborted) {
        yield ledger(
          await new Promise<WorkerQuestion>((resolve) => {
            push = resolve;
          }),
        );
      }
    },
    answerWorkerQuestion: vi.fn(async (input: AnswerWorkerQuestionInput) => {
      answers.push(input);
      const now = answered(input.answer, "10:30", input.replaces ? { revised: true } : {});
      latest = now;
      return now;
    }),
  } satisfies Partial<Api>;
  return {
    api,
    answers,
    /** The ledger moved on elsewhere: another card, the Inbox, a message an agent recorded. */
    elsewhere: async (question: WorkerQuestion) => {
      latest = question;
      await act(async () => push(question));
    },
  };
}

const card = () => screen.getByTestId("worker-question-card");

describe("WorkerQuestionCard", () => {
  it("an answer given elsewhere shows on an open card, without Send, and with who and when", async () => {
    const { api, elsewhere } = fakeApi(forwarded);
    renderWithApi(<WorkerQuestionCard question={forwarded} threadId={orchestratorId} />, api);
    await waitFor(() =>
      expect(within(card()).getByRole("button", { name: "Answer" })).toBeTruthy(),
    );

    await elsewhere(answered("Member", "09:41"));
    await waitFor(() => expect(card().dataset["stage"]).toBe("answered"));
    expect(within(card()).getByTestId("question-status").textContent).toBe(
      "Answered by you · 09:41",
    );
    expect(within(card()).getByTestId("question-outcome").textContent).toBe("Member");
    expect(within(card()).queryByRole("button", { name: "Answer" })).toBeNull();
    expect(within(card()).queryByTestId("question-send")).toBeNull();
    expect(within(card()).getByTestId("question-update")).toBeTruthy();
  });

  it("a card drawn before the ledger is in shows the newer of the two", async () => {
    // The ledger's copy lags the card's: the card's, further along, stands.
    const { api } = fakeApi(forwarded);
    renderWithApi(
      <WorkerQuestionCard question={answered("Admin", "09:50")} threadId={orchestratorId} />,
      api,
    );
    await waitFor(() => expect(card().dataset["stage"]).toBe("answered"));
    expect(within(card()).getByTestId("question-outcome").textContent).toBe("Admin");
  });

  it("Update answer starts from the answer given and sends the change against it", async () => {
    const { api, answers } = fakeApi(answered("Member", "09:41"));
    renderWithApi(<WorkerQuestionCard question={forwarded} threadId={orchestratorId} />, api);
    fireEvent.click(await within(card()).findByTestId("question-update"));
    const member = within(card()).getByRole("radio", { name: /^Member/ }) as HTMLInputElement;
    expect(member.checked).toBe(true);
    // No dismissing an answered question.
    expect(within(card()).queryByTestId("question-dismiss")).toBeNull();
    fireEvent.click(within(card()).getByRole("radio", { name: /^Admin/ }));
    fireEvent.click(within(card()).getByRole("button", { name: "Update answer" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toEqual({
      workspaceId,
      questionId: "WQ7",
      answer: "Admin",
      replaces: { closedAt: Date.parse("2026-11-22T09:41:00") },
    });
    await waitFor(() => expect(within(card()).queryByRole("radio")).toBeNull());
    expect(within(card()).getByTestId("question-outcome").textContent).toBe("Admin");
    expect(within(card()).getByTestId("question-status").textContent).toBe(
      "Answer changed by you · 10:30",
    );
  });

  it("a change made elsewhere while one is open here is shown before another can be sent", async () => {
    const { api, answers, elsewhere } = fakeApi(answered("Member", "09:41"));
    renderWithApi(<WorkerQuestionCard question={forwarded} threadId={orchestratorId} />, api);
    fireEvent.click(await within(card()).findByTestId("question-update"));
    fireEvent.click(within(card()).getByRole("radio", { name: /^Admin/ }));

    await elsewhere(answered("Admin, read-only on kube-system", "09:55", { revised: true }));
    await waitFor(() => expect(within(card()).queryByRole("radio")).toBeNull());
    expect(within(card()).getByTestId("question-overtaken").textContent).toContain("at 09:55");
    expect(within(card()).getByTestId("question-outcome").textContent).toBe(
      "Admin, read-only on kube-system",
    );
    expect(answers).toHaveLength(0);

    // Opened again, it starts from the newer answer and sends against it.
    fireEvent.click(within(card()).getByTestId("question-update"));
    expect(
      (within(card()).getByRole("radio", { name: /^Other/ }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(within(card()).getByRole("radio", { name: /^Member/ }));
    fireEvent.click(within(card()).getByRole("button", { name: "Update answer" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]?.replaces).toEqual({ closedAt: Date.parse("2026-11-22T09:55:00") });
  });

  it("a dismissed or withdrawn question shows how it closed, with nothing to send", async () => {
    const withdrawn: WorkerQuestion = {
      ...forwarded,
      stage: "dismissed",
      reason: "Settled in the design review.",
      withdrawal: { by: "worker", how: "superseded", supersededBy: "WQ8" },
      closedAt: Date.parse("2026-11-22T09:30:00"),
    };
    const { api } = fakeApi(withdrawn);
    renderWithApi(<WorkerQuestionCard question={forwarded} threadId={orchestratorId} />, api);
    await waitFor(() => expect(card().dataset["stage"]).toBe("dismissed"));
    expect(within(card()).getByTestId("question-status").textContent).toBe(
      "Superseded by WQ8 · 09:30",
    );
    expect(within(card()).getByTestId("question-outcome").textContent).toBe(
      "Settled in the design review.",
    );
    expect(within(card()).queryByRole("button")).toBeNull();
  });
});
