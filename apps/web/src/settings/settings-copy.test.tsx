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
 * A setting is a short label, one short line under it that says what it does, and its control. Its
 * caveats and mechanics show behind the ⓘ beside its name, and a consent or legal notice that must
 * be read whole is marked with `LONG_COPY`. What other copy is on screen, such as a status, stays
 * one short line.
 */
const MAX_WORDS = 25;

/** A setting is named in four words or fewer; what it does is the line under its name. */
const MAX_LABEL_WORDS = 4;
// The requested product label is explicit; keep every other row under the existing limit.
const KEEP_AWAKE_LABEL = "Keep computer awake while agents run";

/** The line under a setting's name fits on one line at the narrowest a row gets beside its control. */
const MAX_DESCRIPTION_WORDS = 16;

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

/** Each setting on screen without its line of description, by its label. */
function undescribed(): string[] {
  return [...document.body.querySelectorAll("[data-setting]")]
    .filter((row) => row.querySelector("[data-setting-description]") === null)
    .map((row) => row.querySelector("[data-setting-label]")?.textContent.trim() ?? "(no label)");
}

/** Each setting's line of description that runs past one line, and each group's. */
function longDescriptions(): string[] {
  return [...document.body.querySelectorAll("[data-setting-description]")]
    .map((element) => element.textContent.replace(/\s+/g, " ").trim())
    .filter((text) => words(text) > MAX_DESCRIPTION_WORDS)
    .map((text) => `[${words(text)} words] ${text}`);
}

/** Each group of settings on screen without its sentence under the title, by its title. */
function undescribedGroups(): string[] {
  return [...document.body.querySelectorAll("section[aria-labelledby]")]
    .filter((section) => section.querySelector("h3") !== null)
    .filter(
      (section) =>
        ![...section.querySelectorAll("[data-setting-description]")].some(
          (line) => line.closest("[data-setting]") === null,
        ),
    )
    .map((section) => section.querySelector("h3")!.textContent.trim());
}

/** What on screen breaks the rules above, by rule, so one failure lists them all. */
const problems = () => ({
  longCopy: longCopy(),
  longLabels: longLabels(),
  longDescriptions: longDescriptions(),
  undescribed: undescribed(),
  undescribedGroups: undescribedGroups(),
});

const NONE = {
  longCopy: [],
  longLabels: [],
  longDescriptions: [],
  undescribed: [],
  undescribedGroups: [],
};

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

/** Rows as they were when a label held its description on hover, with nothing under it. */
const OldStyleRow = () => (
  <>
    <div data-setting="">
      <div>
        <span data-setting-label="">Restart sessions after an MCP change</span>
      </div>
    </div>
    <div data-setting="">
      <div>
        <span data-testid="setting-help">
          <span data-setting-label="">Restart on MCP change</span>
        </span>
      </div>
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
      // Voice input on, so the rows it shows only while on are read too.
      await api.updateSettings({ experimental: { voiceInput: true } });
      await renderPage(Page, api);
      expect(problems()).toEqual({
        ...NONE,
        longLabels: _path === "/settings/general" ? [`[6 words] ${KEEP_AWAKE_LABEL}`] : [],
      });
    },
  );

  it("keeps row labels short, with the explicit keep-awake label, platform-only ones included", () => {
    expect(sourceLabels.length).toBeGreaterThan(40);
    expect(
      sourceLabels
        .filter(({ label }) => words(label) > MAX_LABEL_WORDS)
        .map(({ file, label }) => `${file}: ${label}`),
    ).toEqual([`./general-section.tsx: ${KEEP_AWAKE_LABEL}`]);
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
    expect(problems()).toEqual(NONE);
  });

  it("fails a label over four words, and a setting with no line under its name", async () => {
    await renderPage(OldStyleRow, mockApi());
    expect(longLabels()).toEqual(["[6 words] Restart sessions after an MCP change"]);
    expect(undescribed()).toEqual([
      "Restart sessions after an MCP change",
      "Restart on MCP change",
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
