// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReasoningBlock } from "./reasoning-block";

afterEach(cleanup);

describe("ReasoningBlock", () => {
  it("says the model is thinking while the part streams", () => {
    render(<ReasoningBlock isStreaming />);
    expect(screen.getByRole("status").textContent).toContain("Thinking");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("leaves nothing behind once the thinking is done", () => {
    const { container } = render(<ReasoningBlock isStreaming={false} />);
    expect(container.innerHTML).toBe("");
  });
});
