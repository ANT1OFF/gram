// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { answerKey } from "./ask-keys";
import type { QuestionCard } from "./question-card-model";
import { OpenQuestion } from "./question-entry";

// The shared question card: answered only in the ask sheet, with a choice or in words, picked then
// sent with Send answer; elsewhere its Answer goes there. A worker's question can be dismissed with
// an optional reason; the orchestrator's own can't.

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
  it("outside the sheet, shows the question and sends Answer to the one place it is answered", () => {
    const onOpen = vi.fn();
    render(<OpenQuestion card={card()} compact onOpen={onOpen} onDismiss={vi.fn()} />);
    const shown = screen.getByTestId("worker-question");
    expect(shown.dataset["question"]).toBe("WQ1");
    expect(shown.textContent).toContain("Should a deleted cart answer 404 or 410?");
    expect(shown.textContent).toContain("Clients cache 404s for a day.");
    expect(screen.getByTestId("question-note").textContent).toBe(
      "Orchestrator: I'd pick 410; Cart client reads it too.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onOpen).toHaveBeenCalledOnce();
    // No second form: the choices are only where it is answered.
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByTestId("question-send")).toBeNull();
  });

  it("says it is open in the Asks dock instead of offering Answer again", () => {
    render(<OpenQuestion card={card()} compact onOpen={vi.fn()} answering />);
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(screen.getByTestId("question-answering").textContent).toBe("In Asks");
  });

  it("in the sheet, picks a choice and sends it with Send answer; Recommended is a tag, not a pick", async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(<OpenQuestion card={card()} compact={false} sheet onAnswer={onAnswer} />);
    const recommended = screen.getByRole("radio", { name: /^410/ }) as HTMLInputElement;
    expect(recommended.checked).toBe(false);
    expect(screen.getByTestId("choice-recommended").textContent).toBe("Recommended");
    const send = screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(recommended);
    fireEvent.click(send);
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("410"));
  });

  it("in the sheet, a number key picks and ⌘⏎ sends", async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(
      <div
        data-testid="scope"
        onKeyDown={(event) => {
          if (answerKey(event.nativeEvent, event.currentTarget)) event.preventDefault();
        }}
      >
        <OpenQuestion card={card()} compact={false} sheet onAnswer={onAnswer} />
      </div>,
    );
    const scope = screen.getByTestId("scope");
    fireEvent.keyDown(scope, { key: "2" });
    const gone = screen.getByRole("radio", { name: /^410/ }) as HTMLInputElement;
    expect(gone.checked).toBe(true);
    // From the radio it just picked, a number still picks: a radio types nothing.
    fireEvent.keyDown(gone, { key: "1" });
    expect((screen.getByRole("radio", { name: /^404/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.keyDown(scope, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("404"));
  });

  it("sends words when there are no choices, and shows the worker's recommendation", async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(
      <OpenQuestion
        card={card({ options: [], recommended: undefined, recommendation: "410, it's gone" })}
        compact={false}
        sheet
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByTestId("question-recommendation").textContent).toBe(
      "Recommends: 410, it's gone",
    );
    const box = screen.getByPlaceholderText(
      "Sent straight to the worker; the orchestrator gets a copy",
    );
    fireEvent.change(box, { target: { value: "410, and log it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("410, and log it"));
  });

  it("dismisses with a reason, or with none", async () => {
    const onDismiss = vi.fn(async () => undefined);
    render(<OpenQuestion card={card()} compact onOpen={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("question-dismiss"));
    fireEvent.change(screen.getByTestId("question-dismiss-reason"), {
      target: { value: "  Out of scope  " },
    });
    fireEvent.click(screen.getByTestId("question-dismiss-confirm"));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith("Out of scope"));
    cleanup();
    const bare = vi.fn(async () => undefined);
    render(<OpenQuestion card={card()} compact onOpen={vi.fn()} onDismiss={bare} />);
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
        compact={false}
        sheet
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByTestId("memory-question")).toBeTruthy();
    expect(screen.queryByTestId("question-dismiss")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /^404/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect((await screen.findByRole("alert")).textContent).toBe("WQ1 is answered already.");
  });
});
