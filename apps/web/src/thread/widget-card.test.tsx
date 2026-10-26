// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { WidgetCard } from "./widget-card";

const widget = {
  id: "w1",
  title: "Latency by region",
  svg: '<svg viewBox="0 0 10 10"><script>alert(1)</script><rect fill="var(--accent)"/></svg>',
};

const drawing = (img: HTMLElement) => {
  const src = img.getAttribute("src") ?? "";
  return decodeURIComponent(src.slice(src.indexOf(",") + 1));
};

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-mode");
});

describe("WidgetCard", () => {
  it("shows the drawing as an image, never as markup in the page", () => {
    document.documentElement.style.setProperty("--accent", "#7aa2f7");
    render(<WidgetCard widget={widget} />);
    const img = screen.getByRole("img", { name: "Latency by region" });
    expect(img.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
    expect(drawing(img)).toContain("<style>:root{--accent:#7aa2f7}</style>");
    expect(document.querySelector("script, svg")).toBeNull();
    expect(screen.getByTestId("widget").textContent).toContain("Latency by region");
  });

  it("redraws with the new values when the theme changes", async () => {
    document.documentElement.style.setProperty("--accent", "#7aa2f7");
    render(<WidgetCard widget={widget} />);
    await act(async () => {
      document.documentElement.style.setProperty("--accent", "#2e7de9");
      document.documentElement.setAttribute("data-mode", "light");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(drawing(screen.getByRole("img", { name: "Latency by region" }))).toContain(
      "--accent:#2e7de9",
    );
  });

  it("opens full size", async () => {
    render(<WidgetCard widget={widget} />);
    await userEvent.click(screen.getByRole("button", { name: "Open Latency by region" }));
    expect(await screen.findByTestId("widget-full")).toBeTruthy();
  });
});
