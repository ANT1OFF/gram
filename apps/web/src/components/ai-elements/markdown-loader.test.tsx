// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Loader from "./markdown-loader";

// Over a slow link the link carries one thing after another, so a transcript holds the renderer's
// load until its messages are in; on a good link the load starts at once, as rows wait for it.
const loads = { count: 0 };

beforeEach(() => {
  vi.resetModules();
  loads.count = 0;
  vi.doMock("./markdown", () => {
    loads.count += 1;
    return {};
  });
});

afterEach(() => {
  cleanup();
  vi.doUnmock("./markdown");
  vi.doUnmock("@/shell/constrained-link");
});

/** The loader as each test loads it, over the modules it set up. */
let loader: typeof Loader;
const Probe = ({ start }: { start: boolean }) => {
  const state = loader.useMarkdown(start);
  return <p data-testid="state">{state.module ? "loaded" : state.plain ? "plain" : "pending"}</p>;
};

describe("useMarkdown", () => {
  it("holds the load over a slow link until it is told to start", async () => {
    vi.doMock("@/shell/constrained-link", () => ({ thisLinkIsConstrained: () => true }));
    loader = await import("./markdown-loader");
    const { rerender } = render(<Probe start={false} />);
    expect(screen.getByTestId("state").textContent).toBe("plain");
    await new Promise((done) => setTimeout(done, 20));
    expect(loads.count).toBe(0);

    rerender(<Probe start />);
    await vi.waitFor(() => expect(screen.getByTestId("state").textContent).toBe("loaded"));
    expect(loads.count).toBe(1);
  });

  it("loads at once on a good link, held or not", async () => {
    vi.doMock("@/shell/constrained-link", () => ({ thisLinkIsConstrained: () => false }));
    loader = await import("./markdown-loader");
    render(<Probe start={false} />);
    await vi.waitFor(() => expect(screen.getByTestId("state").textContent).toBe("loaded"));
    expect(loads.count).toBe(1);
  });
});
