// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { QuestionCard } from "./question-card-model";
import { OpenQuestion } from "./question-entry";

// The shared question card: a worker's question is answered with a choice or in words, or
// dismissed with an optional reason; the orchestrator's own can't be dismissed.

afterEach(cleanup);

const card = (more: Partial<QuestionCard> = {}): QuestionCard => ({
  key: "WQ1",
  id: "WQ1",
  text: "Should a deleted cart answer 404 or 410?",
  detail: "Clients cache 404s for a day.",
  options: [{ label: "404" }, { label: "410", description: "Gone" }],
  multiSelect: false,
  recommended: "410",
  note: "I'd pick 410; Cart client reads it too.",
  status: "Forwarded to you · 11:02",
  to: "worker",
  dismissable: true,
  ...more,
});

describe("OpenQuestion", () => {
  it("shows the worker's words, its context and the orchestrator's line, and sends a choice", async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(<OpenQuestion card={card()} compact onAnswer={onAnswer} onDismiss={vi.fn()} />);
    const shown = screen.getByTestId("worker-question");
    expect(shown.dataset["question"]).toBe("WQ1");
    expect(shown.textContent).toContain("Should a deleted cart answer 404 or 410?");
    expect(shown.textContent).toContain("Clients cache 404s for a day.");
    expect(screen.getByTestId("question-note").textContent).toBe(
      "Orchestrator: I'd pick 410; Cart client reads it too.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    fireEvent.click(screen.getByRole("radio", { name: /^410/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send to the worker" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("410"));
  });

  it("sends words when there are no choices, and shows the worker's recommendation", async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(
      <OpenQuestion
        card={card({ options: [], recommended: undefined, recommendation: "410, it's gone" })}
        compact={false}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByTestId("question-recommendation").textContent).toBe(
      "Recommends: 410, it's gone",
    );
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    const box = screen.getByPlaceholderText(
      "Sent straight to the worker; the orchestrator gets a copy",
    );
    fireEvent.change(box, { target: { value: "410, and log it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to the worker" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("410, and log it"));
  });

  it("dismisses with a reason, or with none", async () => {
    const onDismiss = vi.fn(async () => undefined);
    render(<OpenQuestion card={card()} compact onAnswer={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("question-dismiss"));
    fireEvent.change(screen.getByTestId("question-dismiss-reason"), {
      target: { value: "  Out of scope  " },
    });
    fireEvent.click(screen.getByTestId("question-dismiss-confirm"));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith("Out of scope"));
    cleanup();
    const bare = vi.fn(async () => undefined);
    render(<OpenQuestion card={card()} compact onAnswer={vi.fn()} onDismiss={bare} />);
    fireEvent.click(screen.getByTestId("question-dismiss"));
    fireEvent.click(screen.getByTestId("question-dismiss-confirm"));
    await waitFor(() => expect(bare).toHaveBeenCalledWith(undefined));
  });

  it("says why a refused answer didn't go, and keeps the orchestrator's own undismissable", async () => {
    const onAnswer = vi.fn(async () => {
      throw new Error("WQ1 is answered already.");
    });
    render(
      <OpenQuestion
        card={card({ to: "orchestrator", dismissable: false, id: "Q1", note: undefined })}
        compact
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByTestId("memory-question")).toBeTruthy();
    expect(screen.queryByTestId("question-dismiss")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    fireEvent.click(screen.getByRole("radio", { name: /^404/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send to the orchestrator" }));
    expect((await screen.findByRole("alert")).textContent).toBe("WQ1 is answered already.");
  });
});
