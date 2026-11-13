// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { boardRequestOf, DISCOVER_MESSAGE } from "@/orchestration/board-model";

import { BoardRequestBubble } from "./board-request-bubble";

afterEach(cleanup);

it("shows the request's name and line, and what was sent only when asked", () => {
  render(
    <BoardRequestBubble request={boardRequestOf(DISCOVER_MESSAGE)!} text={DISCOVER_MESSAGE} />,
  );

  const bubble = screen.getByTestId("board-request");
  expect(bubble.textContent).toContain("Discover workspace");
  expect(bubble.textContent).not.toContain("Spawn one worker");

  const toggle = screen.getByRole("button", { name: "What was sent" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByTestId("board-request-sent").textContent).toBe(DISCOVER_MESSAGE);
});
