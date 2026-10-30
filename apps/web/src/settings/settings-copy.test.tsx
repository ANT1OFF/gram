// @vitest-environment happy-dom
import type { ProjectId } from "@gram/contracts";
import { act, cleanup } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { renderWithRouter } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { LONG_COPY } from "./fields";
import { ALL_SETTINGS_PAGES } from "./pages";
import { WorkspaceSettingsPage } from "./workspace-page";

/**
 * A setting is a short label and its control. What it does, its caveats and mechanics show on the
 * label's hover or focus, and a consent or legal notice that must be read whole is marked with
 * `LONG_COPY`. What copy is left on screen, such as a status, stays one short line.
 */
const MAX_WORDS = 25;

/** A setting is named in four words or fewer; what it does shows on its label's hover. */
const MAX_LABEL_WORDS = 4;

const words = (text: string) =>
  text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

/**
 * Each Settings route that renders a page, by path; the ones that only redirect have none. A
 * page's own sub-page, such as one workspace's (`settings.workspaces_.$workspaceId`), takes a
 * parameter and is checked on its own below.
 */
const routes = Object.entries(
  import.meta.glob<{ Route: { options: { component?: ComponentType } } }>(
    "../routes/settings.*.tsx",
    { eager: true },
  ),
).flatMap(([file, module]) => {
  const component = module.Route.options.component;
  const path = file.replace(/^.*settings\.(.*)\.tsx$/, "/settings/$1");
  return component === undefined || path.includes("$") ? [] : [{ path, component }];
});

/**
 * Each row label written out in a settings source file, for rows the rendered pages don't show
 * here: a desktop-only or platform-only setting, or one a fixture doesn't reach.
 */
const sourceLabels = Object.entries(
  import.meta.glob<string>(["./*.tsx", "!./*.test.tsx"], {
    eager: true,
    query: "?raw",
    import: "default",
  }),
).flatMap(([file, source]) =>
  [...source.matchAll(/<(?:Toggle|SettingRow|Field|NumberField)\s+label="([^"]+)"/g)].map(
    (match) => ({ file, label: match[1]! }),
  ),
);

/** Block content, which makes a `p` or `li` a container rather than one line of copy. */
const BLOCK = "p, li, div, ul, ol, section, details";

/** The text of each description element on screen that is longer than `MAX_WORDS`. */
function longCopy(): string[] {
  return [...document.body.querySelectorAll("p, li")]
    .filter((element) => element.querySelector(BLOCK) === null)
    .filter((element) => element.closest(`[${LONG_COPY}]`) === null)
    .map((element) => element.textContent.replace(/\s+/g, " ").trim())
    .filter((text) => words(text) > MAX_WORDS)
    .map((text) => `[${words(text)} words] ${text}`);
}

/** Each setting's label on screen that is longer than `MAX_LABEL_WORDS`. */
function longLabels(): string[] {
  return [...document.body.querySelectorAll("[data-setting-label]")]
    .map((element) => element.textContent.replace(/\s+/g, " ").trim())
    .filter((text) => words(text) > MAX_LABEL_WORDS)
    .map((text) => `[${words(text)} words] ${text}`);
}

/**
 * Descriptions shown under a setting's label, where they used to be: a row is its label, which
 * holds its help, and its control.
 */
function visibleDescriptions(): string[] {
  return [...document.body.querySelectorAll("[data-setting] [data-setting-label]")].flatMap(
    (label) => {
      // A label with help sits in the element that shows it; the row's line is around that.
      const name = label.closest('[data-testid="setting-help"]') ?? label;
      const next = name.parentElement?.nextElementSibling;
      if (next?.tagName !== "P" || next.getAttribute("role") === "alert") return [];
      return next.closest(`[${LONG_COPY}]`) === null ? [next.textContent.trim()] : [];
    },
  );
}

/** Renders `Page` against `api`, with its settings in the store, once its queries have settled. */
async function renderPage(Page: ComponentType, api: MockApi) {
  useServerSettings.setState({ settings: await api.getSettings() });
  renderWithRouter(<Page />, api);
  for (let i = 0; i < 5; i++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
}

const mockApi = () => createMockApi({ speed: 0, autoplay: false });

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

/** A row as it was before labels went short and descriptions went into their help. */
const OldStyleRow = () => (
  <>
    <div data-setting="">
      <div>
        <span data-setting-label="">Restart sessions after an MCP change</span>
      </div>
      <p>Reload live sessions when Gram adds or removes a server.</p>
    </div>
    {/* The same with its label in the element that shows its help. */}
    <div data-setting="">
      <div>
        <span data-testid="setting-help">
          <span data-setting-label="">Restart on MCP change</span>
        </span>
      </div>
      <p>Reload live sessions when Gram adds or removes a server.</p>
    </div>
  </>
);

describe("settings copy", () => {
  it("finds every page's route", () => {
    expect(routes.map((route) => route.path).toSorted()).toEqual(
      ALL_SETTINGS_PAGES.map((page) => page.path).toSorted(),
    );
  });

  it.each(ALL_SETTINGS_PAGES.map((page) => [page.path, page.description]))(
    "%s has a short page description",
    (_path, description) => {
      expect(words(description)).toBeLessThanOrEqual(MAX_WORDS);
    },
  );

  it.each(routes.map((route) => [route.path, route.component] as const))(
    "%s keeps each description to one short line",
    async (_path, Page) => {
      const api = mockApi();
      // Every experimental page on, so a switched-off feature's settings are read too.
      await api.updateSettings({ experimental: { voiceInput: true } });
      await renderPage(Page, api);
      expect(longCopy()).toEqual([]);
      expect(longLabels()).toEqual([]);
      expect(visibleDescriptions()).toEqual([]);
    },
  );

  it("names every row in four words or fewer, platform-only ones included", () => {
    expect(sourceLabels.length).toBeGreaterThan(40);
    expect(
      sourceLabels
        .filter(({ label }) => words(label) > MAX_LABEL_WORDS)
        .map(({ file, label }) => `${file}: ${label}`),
    ).toEqual([]);
  });

  it("keeps a workspace's charter short too", async () => {
    const api = mockApi();
    const projectId = "p-api" as ProjectId;
    const state = await api.saveWorkspace({
      name: "api",
      projectIds: [projectId],
      homeProjectId: projectId,
    });
    const workspaces = routes.find((route) => route.path === "/settings/workspaces")!;
    await renderPage(workspaces.component, api);
    expect(document.body.textContent).toContain("api");
    expect(longCopy()).toEqual([]);
    expect(longLabels()).toEqual([]);
    cleanup();
    // And the workspace's own page, where its charter is.
    await renderPage(() => <WorkspaceSettingsPage workspaceId={state.workspace.id} />, api);
    expect(document.body.textContent).toContain("Reviews & merging");
    expect(longCopy()).toEqual([]);
    expect(longLabels()).toEqual([]);
    expect(visibleDescriptions()).toEqual([]);
  });

  it("fails a label over four words, and a description shown beside its setting", async () => {
    await renderPage(OldStyleRow, mockApi());
    expect(longLabels()).toEqual(["[6 words] Restart sessions after an MCP change"]);
    expect(visibleDescriptions()).toEqual([
      "Reload live sessions when Gram adds or removes a server.",
      "Reload live sessions when Gram adds or removes a server.",
    ]);
  });

  it("fails a description over the limit, and leaves marked copy alone", async () => {
    const long = Array.from({ length: MAX_WORDS + 1 }, (_, i) => `word${i}`).join(" ");
    const Page = () => (
      <>
        <p>{long}</p>
        <p {...{ [LONG_COPY]: "consent" }}>{long}</p>
      </>
    );
    await renderPage(Page, mockApi());
    expect(longCopy()).toEqual([`[${MAX_WORDS + 1} words] ${long}`]);
  });
});
