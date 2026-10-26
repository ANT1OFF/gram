// @vitest-environment happy-dom
import {
  DEFAULT_SETTINGS,
  type ThreadId,
  type ThreadSummary,
  type UsageSummary,
} from "@gram/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextRing, ringLabel, ringOffset } from "@/composer/context-ring";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";
import { themeStore } from "@/theme/store";

// NumberFlow's custom element doesn't upgrade in happy-dom, so an animated ticker throws; the
// digits aren't what these tests measure.
vi.mock("@/motion/number-ticker", () => ({
  NumberTicker: ({ value, countUp }: { value: number; countUp?: boolean }) => (
    <span data-count-up={countUp ? "" : undefined}>{value}</span>
  ),
}));

import {
  contextLevel,
  contextPercent,
  contextTokensLabel,
  contextUsage,
  UsageBar,
} from "./usage-bar";

const usage = (overrides: Partial<UsageSummary> = {}): UsageSummary => ({
  tokens: { inputTokens: 58_400, outputTokens: 2_150, cacheReadTokens: 31_000 },
  contextWindow: 200_000,
  contextTokens: 90_000,
  costUsd: 0.42,
  ...overrides,
});

/** Usage as an agent that doesn't report the latest request's size. */
const withoutContextTokens = (): UsageSummary => {
  const { contextTokens: _unset, ...rest } = usage();
  return rest;
};

const setMotion = (motion: "system" | "reduced" | "off") =>
  act(() => themeStore.setState({ motion }));

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ usage: {}, byId: {} });
  useServerSettings.setState({ settings: undefined });
  themeStore.setState({ motion: themeStore.getInitialState().motion });
});

describe("context percent", () => {
  it("rounds the latest request against the window and caps at 100", () => {
    expect(contextPercent(usage())).toBe(45);
    expect(contextPercent(usage({ contextTokens: 0 }))).toBe(0);
    expect(contextPercent(usage({ contextTokens: 260_000 }))).toBe(100);
  });

  it("measures the latest request, not the turn's cumulative cache reads", () => {
    // Twelve tool calls re-read the same cached prompt: the cumulative sum is past the window.
    const turn = usage({
      tokens: { inputTokens: 162, outputTokens: 35_900, cacheReadTokens: 720_000 },
      contextTokens: 60_000,
    });
    expect(contextPercent(turn)).toBe(30);
  });

  it("is unknown without a window or the latest request's size", () => {
    const { contextWindow: _unset, ...noWindow } = usage();
    expect(contextPercent(noWindow)).toBeUndefined();
    expect(contextPercent(usage({ contextWindow: 0 }))).toBeUndefined();
    expect(contextPercent(withoutContextTokens())).toBeUndefined();
  });

  it("keeps the tokens behind the percent, and each side it knows without the other", () => {
    expect(contextUsage(usage())).toEqual({ tokens: 90_000, window: 200_000, percent: 45 });
    const { contextWindow: _unset, ...noWindow } = usage();
    expect(contextUsage(noWindow)).toEqual({ tokens: 90_000 });
    expect(contextUsage(usage({ contextWindow: 0 }))).toEqual({ tokens: 90_000 });
    expect(contextUsage(withoutContextTokens())).toEqual({ window: 200_000 });
    const turnTokensOnly: UsageSummary = { tokens: { inputTokens: 0, outputTokens: 0 } };
    expect(contextUsage(turnTokensOnly)).toEqual({});
  });

  it("is normal, then warning from 90%, then critical from 97%", () => {
    expect([0, 89, 90, 96, 97, 100].map(contextLevel)).toEqual([
      "normal",
      "normal",
      "warning",
      "warning",
      "critical",
      "critical",
    ]);
  });
});

describe("context tokens label", () => {
  it("shows the used and window tokens compactly", () => {
    expect(contextTokensLabel(contextUsage(usage({ contextTokens: 138_000 })))).toBe(
      "138K / 200K tokens",
    );
    expect(contextTokensLabel({ tokens: 940, window: 8_192, percent: 11 })).toBe(
      "940 / 8.2K tokens",
    );
  });

  it("keeps large windows short", () => {
    expect(contextTokensLabel({ tokens: 1_234_567, window: 2_000_000, percent: 62 })).toBe(
      "1.2M / 2M tokens",
    );
    expect(contextTokensLabel({ tokens: 999_999, window: 1_000_000, percent: 100 })).toBe(
      "1M / 1M tokens",
    );
  });

  it("shows whichever side is known, and nothing rather than NaN or 0 / 0", () => {
    expect(contextTokensLabel({ tokens: 90_000 })).toBe("90K tokens in context");
    expect(contextTokensLabel({ window: 272_000 })).toBe("272K token window");
    expect(contextTokensLabel({})).toBeUndefined();
    expect(contextTokensLabel(contextUsage(usage({ contextWindow: 0, contextTokens: 0 })))).toBe(
      "0 tokens in context",
    );
  });
});

describe("UsageBar", () => {
  it("shows the share of the window and the tokens it stands for, not the turn's in and out", () => {
    setMotion("off");
    render(<UsageBar usage={usage({ contextTokens: 138_000 })} />);
    const context = screen.getByTestId("usage-context");
    // The mocked ticker prints the raw fraction.
    expect(context.textContent).toBe("0.69 · 138K / 200K tokens");
    expect(screen.getByTestId("usage").textContent).not.toMatch(/\bin\b|\bout\b/);
  });

  it("marks the cost as a guess only while the running turn is unpriced", () => {
    setMotion("off");
    render(<UsageBar usage={usage({ costEstimated: true })} showCost />);
    expect(screen.getByTestId("usage-cost").textContent).toBe("~0.42");
    cleanup();
    render(<UsageBar usage={usage()} showCost />);
    expect(screen.getByTestId("usage-cost").textContent).toBe("0.42");
  });

  it("leaves dollars out unless asked, keeping the tokens", () => {
    setMotion("off");
    render(<UsageBar usage={usage()} />);
    expect(screen.queryByTestId("usage-cost")).toBeNull();
    expect(screen.getByTestId("usage").textContent).toContain("90K / 200K tokens");
  });

  it("hides the meter without the latest request's size or a window, keeping what is known", () => {
    setMotion("off");
    render(<UsageBar usage={withoutContextTokens()} showCost />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByTestId("usage-context").textContent).toBe("200K token window");
    expect(screen.getByTestId("usage-cost").textContent).toBe("0.42");
    cleanup();
    const { contextWindow: _unset, ...noWindow } = usage();
    render(<UsageBar usage={noWindow} />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByTestId("usage-context").textContent).toBe("90K tokens in context");
    cleanup();
    render(<UsageBar usage={{ tokens: { inputTokens: 6, outputTokens: 1_100 } }} />);
    expect(screen.getByTestId("usage-context").textContent).toBe("Context not reported yet");
  });

  it("shows the latest request's share, however much the turn read cumulatively", () => {
    setMotion("off");
    render(
      <UsageBar
        usage={usage({
          tokens: { inputTokens: 162, outputTokens: 35_900, cacheReadTokens: 720_000 },
          contextTokens: 60_000,
          costUsd: 6.89,
        })}
      />,
    );
    expect(screen.getByRole("meter", { name: "Context used" }).getAttribute("aria-valuenow")).toBe(
      "30",
    );
  });

  it("marks the threshold it's in by colour alone", () => {
    setMotion("off");
    render(<UsageBar usage={usage({ contextTokens: 170_000 })} />);
    expect(screen.getByRole("meter").parentElement?.dataset["level"]).toBe("normal");
    cleanup();
    render(<UsageBar usage={usage({ contextTokens: 186_000 })} />);
    const meter = screen.getByRole("meter", { name: "Context used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("93");
    expect(meter.getAttribute("aria-valuetext")).toBe(
      "93% of the context window, 186K / 200K tokens",
    );
    expect(meter.parentElement?.dataset["level"]).toBe("warning");
    cleanup();
    render(<UsageBar usage={usage({ contextTokens: 198_000 })} />);
    expect(screen.getByRole("meter").parentElement?.dataset["level"]).toBe("critical");
    expect(screen.getByTestId("usage-fill").className).not.toContain("animate-pulse");
  });

  it("at Motion Off, shows the final fill at once", () => {
    setMotion("off");
    render(<UsageBar usage={usage()} />);
    expect(screen.getByTestId("usage-fill").style.width).toBe("45%");
  });

  it("at Motion Full, grows the fill in from empty", async () => {
    setMotion("system");
    render(<UsageBar usage={usage()} />);
    expect(screen.getByTestId("usage-fill").style.width).toBe("0%");
    await waitFor(() => expect(screen.getByTestId("usage-fill").style.width).toBe("45%"));
  });
});

describe("UsageBar count-up", () => {
  it("counts up between reports unless told not to, as an unfocused pane is", () => {
    const { container, rerender } = render(<UsageBar usage={usage()} showCost />);
    expect(container.querySelectorAll("[data-count-up]")).toHaveLength(1);
    rerender(<UsageBar usage={usage()} countUp={false} showCost />);
    expect(container.querySelectorAll("[data-count-up]")).toHaveLength(0);
    expect(screen.getByTestId("usage-cost").textContent).toBe("0.42");
  });
});

describe("ContextRing", () => {
  const THREAD = "t-ring" as ThreadId;
  const renderRing = (value: UsageSummary) => {
    useThreadsStore.setState({ usage: { [THREAD]: value } });
    render(<ContextRing threadId={THREAD} countUp={false} />);
    return screen.getByTestId("usage-ring");
  };

  it("draws the filled share of the ring, clamped to the circle", () => {
    const full = ringOffset(0);
    expect(ringOffset(100)).toBe(0);
    expect(ringOffset(25)).toBeCloseTo(full * 0.75);
    expect(ringOffset(140)).toBe(0);
    expect(ringOffset(-5)).toBe(full);
  });

  it("names the context filled, or just usage without a window", () => {
    expect(ringLabel(31)).toBe("Usage: 31% of the context window");
    expect(ringLabel(undefined)).toBe("Usage");
  });

  it("renders nothing before the thread reports usage", () => {
    render(<ContextRing threadId={THREAD} countUp={false} />);
    expect(screen.queryByTestId("usage-ring")).toBeNull();
  });

  it("fills to the context used and colours it by level", () => {
    const ring = renderRing(usage({ contextTokens: 186_000 }));
    expect(ring.getAttribute("aria-label")).toBe("Usage: 93% of the context window");
    expect(ring.dataset["level"]).toBe("warning");
    expect(ring.querySelectorAll("circle")).toHaveLength(2);
  });

  it("is only a dashed track without a window, and still opens onto what is known", async () => {
    const ring = renderRing(withoutContextTokens());
    expect(ring.getAttribute("aria-label")).toBe("Usage");
    const circles = ring.querySelectorAll("circle");
    expect(circles).toHaveLength(1);
    expect(circles[0]!.getAttribute("stroke-dasharray")).not.toBeNull();

    fireEvent.click(ring);
    await screen.findByTestId("usage");
    expect(screen.getByTestId("usage-context").textContent).toBe("200K token window");
    // A thread on the subscription, so no dollars.
    expect(screen.queryByTestId("usage-cost")).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  const thread = (profileId?: string) =>
    ({
      thread: {
        id: THREAD,
        model: { agent: "codex", model: "gpt", ...(profileId ? { profileId } : {}) },
      },
    }) as unknown as ThreadSummary;
  /** Opens the ring of `summary`'s thread with Show dollar cost at `showCost`; the cost it shows. */
  const costShownIn = async (summary: ThreadSummary, showCost: boolean) => {
    cleanup();
    useServerSettings.setState({
      settings: { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, showCost } },
    });
    useThreadsStore.setState({ byId: { [THREAD]: summary } });
    fireEvent.click(renderRing(usage()));
    await screen.findByTestId("usage");
    return screen.queryByTestId("usage-cost")?.textContent ?? null;
  };

  it("shows dollars only for a gateway thread with Show dollar cost on", async () => {
    expect(await costShownIn(thread("gw"), true)).toBe("0.42");
    expect(await costShownIn(thread("gw"), false)).toBeNull();
    expect(await costShownIn(thread(), true)).toBeNull();
  });
});
