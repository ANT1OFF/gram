// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "lucide-react";
import { afterEach, expect, it } from "vitest";

import { TooltipProvider } from "./tooltip";
import { Button, buttonVariants } from "./button";

afterEach(cleanup);

it("gives every icon button a 28 px square, an inline glyph at 14 px and a chrome glyph at 16 px", () => {
  for (const size of ["icon-xs", "icon-sm"] as const) {
    expect(buttonVariants({ size })).toMatch(/\bsize-7\b/);
  }
  expect(buttonVariants({ size: "icon-xs" })).toContain("[&_svg:not([class*='size-'])]:size-3.5");
  // icon-sm leaves the glyph at the base's 16 px.
  expect(buttonVariants({ size: "icon-sm" })).not.toMatch(/:size-3(\.5)?\b/);
  expect(buttonVariants({ size: "icon-sm" })).toContain("[&_svg:not([class*='size-'])]:size-4");
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
