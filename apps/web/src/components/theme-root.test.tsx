// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ThemeRoot } from "./theme-root";

const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme-booting");
});

describe("ThemeRoot", () => {
  it("syncs the theme, then clears the boot flag once that has painted", async () => {
    document.documentElement.setAttribute("data-theme-booting", "");
    render(
      <ThemeRoot>
        <p>app</p>
      </ThemeRoot>,
    );

    expect(document.documentElement.getAttribute("data-look")).toBeTruthy();
    expect(document.documentElement.hasAttribute("data-theme-booting")).toBe(true);
    await frames();
    await frames();
    expect(document.documentElement.hasAttribute("data-theme-booting")).toBe(false);
  });
});
