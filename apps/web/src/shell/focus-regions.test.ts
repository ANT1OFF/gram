// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { useLayoutStore } from "@/stores/layout";

import { OVERVIEW_ROOT } from "@/views/shell-layout";

import { focusPanel, focusSidebar, OVERVIEW_STOP } from "./focus-regions";

afterEach(() => {
  document.body.replaceChildren();
});

const stop = (text: string, current = false) => {
  const element = document.createElement("button");
  element.setAttribute(OVERVIEW_STOP, "");
  element.textContent = text;
  if (current) element.setAttribute("aria-current", "true");
  return element;
};

describe("focusSidebar", () => {
  it("focuses the overview's current row, showing a hidden overview first", async () => {
    useLayoutStore.setState({ overviewSidebar: "hidden", focusMode: false, windowWidth: 1440 });
    const overview = document.createElement("div");
    overview.setAttribute(OVERVIEW_ROOT, "");
    overview.append(stop("first"), stop("open", true));
    document.body.append(overview);

    expect(await focusSidebar()).toBe(true);
    expect(document.activeElement?.textContent).toBe("open");
    expect(useLayoutStore.getState().overviewSidebar).not.toBe("hidden");
  });
});

describe("focusPanel", () => {
  it("opens the panel and focuses its selected tab once it renders", async () => {
    useLayoutStore.setState({ panelOpen: false, threadInView: true, windowWidth: 1440 });
    const pending = focusPanel();
    expect(useLayoutStore.getState().panelOpen).toBe(true);

    const panel = document.createElement("aside");
    panel.dataset.testid = "right-panel";
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "true");
    tab.textContent = "Files";
    panel.append(tab);
    document.body.append(panel);

    expect(await pending).toBe(true);
    expect(document.activeElement).toBe(tab);
  });
});
