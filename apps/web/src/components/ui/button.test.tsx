// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "lucide-react";
import { afterEach, expect, it } from "vitest";

import { TooltipProvider } from "./tooltip";
import { Button, buttonVariants } from "./button";

afterEach(cleanup);

it("gives every icon button a 28 px square, a row glyph at 16 px and a toolbar glyph at 18 px", () => {
  for (const size of ["icon-xs", "icon-sm"] as const) {
    expect(buttonVariants({ size })).toMatch(/\bsize-7\b/);
  }
  expect(buttonVariants({ size: "icon-xs" })).toContain(
    "[&_svg:not([class*='size-'])]:size-icon-row",
  );
  expect(buttonVariants({ size: "icon-sm" })).toContain(
    "[&_svg:not([class*='size-'])]:size-icon-bar",
  );
  // Icon sizes come from the tokens, never a raw step.
  for (const size of ["icon-xs", "icon-sm", "xs", "sm", "default"] as const) {
    expect(buttonVariants({ size })).not.toMatch(/svg[^\s]*\]:size-\d/);
  }
});

it("shows an icon button's title as its tooltip at once, not as a native title", async () => {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <Button size="icon-sm" variant="ghost" aria-label="Settings" title="Settings (⌘,)">
        <Settings />
      </Button>
    </TooltipProvider>,
  );
  const button = screen.getByRole("button", { name: "Settings" });
  expect(button.getAttribute("title")).toBeNull();
  await user.hover(button);
  expect((await screen.findByText("Settings (⌘,)")).textContent).toBe("Settings (⌘,)");
});

it("keeps a native title on a button with words", () => {
  render(
    <Button size="sm" title="Opens the PR">
      Open
    </Button>,
  );
  expect(screen.getByRole("button", { name: "Open" }).getAttribute("title")).toBe("Opens the PR");
});
