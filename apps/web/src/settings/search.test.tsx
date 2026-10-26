// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";

import { Field, Toggle } from "./fields";
import { KeyboardSection } from "./keyboard-section";
import { listedSettingsPages, settingsPagesFor } from "./pages";
import { matchesSearch, searchWords } from "./search";
import {
  firstMatchedPage,
  SearchEmptyState,
  SearchScope,
  SettingsSearchBox,
  SettingsSearchProvider,
} from "./search-scope";

afterEach(cleanup);

const FONT_SIZE = {
  label: "Terminal font size",
  description: "In pixels, 8–32. Leave empty for the default.",
  keywords: ["text size"],
  section: "Appearance",
};

describe("matchesSearch", () => {
  it.each([
    ["", true],
    ["   ", true],
    ["font", true],
    ["FONT", true],
    ["pixels", true],
    ["text size", true],
    ["appearance", true],
    ["size terminal", true],
    ["appearance font", true],
    ["  font   size ", true],
    ["font family", false],
    ["shell", false],
  ])("%j → %s", (query, expected) => {
    expect(matchesSearch(query, FONT_SIZE)).toBe(expected);
  });

  it("matches on a label alone", () => {
    expect(matchesSearch("sound", { label: "Sound" })).toBe(true);
    expect(matchesSearch("sound", { label: "Branch prefix" })).toBe(false);
  });

  it("doesn't match a word split across two fields", () => {
    expect(matchesSearch("sizein", FONT_SIZE)).toBe(false);
  });

  it("splits the query into lower-case words", () => {
    expect(searchWords("  Dark  MODE ")).toEqual(["dark", "mode"]);
    expect(searchWords(" ")).toEqual([]);
  });
});

const page = (query: string) =>
  render(
    <SettingsSearchProvider query={query}>
      <SearchScope as="section" section label="General" id="general">
        <Field label="Branch prefix" description="New worktree branches start with this.">
          <input aria-label="prefix" />
        </Field>
        <Toggle
          label="Follow worktree moves"
          keywords={["cwd"]}
          checked={false}
          onChange={() => {}}
        />
        <SearchScope label="Open in editor" keywords={["vscode"]}>
          <Field label="Command">
            <input aria-label="command" />
          </Field>
        </SearchScope>
      </SearchScope>
      <SearchEmptyState query={query} />
    </SettingsSearchProvider>,
  );

const settingOf = (text: string) => screen.getByText(text).closest("[data-setting]")!;
const matches = () =>
  [...document.querySelectorAll("[data-setting-match]")].map(
    (el) => el.id || el.querySelector("label, span")?.textContent,
  );

const keyboard = (query: string) =>
  renderWithApi(
    <SettingsSearchProvider query={query}>
      <SearchScope as="section" section label="Keyboard" id="keyboard">
        <KeyboardSection />
      </SearchScope>
    </SettingsSearchProvider>,
    {},
  );
const shown = () =>
  [...document.querySelectorAll("li[data-testid^='binding-']:not([hidden])")].map((row) =>
    row.getAttribute("data-testid"),
  );

describe("settings search scopes", () => {
  it("hides and marks nothing without a query", () => {
    page("");
    expect(document.querySelectorAll("[hidden], [data-setting-match]")).toHaveLength(0);
    expect(screen.queryByTestId("settings-search-empty")).toBeNull();
  });

  it("hides the settings a query doesn't match, by label, description or keyword", () => {
    page("worktree");
    expect(matches()).toEqual(["Branch prefix", "Follow worktree moves"]);
    expect(settingOf("Command").hasAttribute("hidden")).toBe(true);
    cleanup();

    page("cwd");
    expect(matches()).toEqual(["Follow worktree moves"]);
    expect(settingOf("Branch prefix").hasAttribute("hidden")).toBe(true);
  });

  it("shows everything inside a scope the query names", () => {
    page("vscode");
    expect(matches()).toEqual(["Command"]);
    expect(settingOf("Command").hasAttribute("hidden")).toBe(false);
    expect(settingOf("Branch prefix").hasAttribute("hidden")).toBe(true);
    cleanup();

    page("general");
    expect(matches()).toEqual(["general"]);
    expect(document.querySelectorAll("[hidden]")).toHaveLength(0);
  });

  it("keeps a setting mounted while it's hidden, so a draft survives a search", () => {
    const view = page("");
    const input = screen.getByLabelText<HTMLInputElement>("prefix");
    input.value = "half-typed";
    view.rerender(
      <SettingsSearchProvider query="vscode">
        <SearchScope as="section" section label="General" id="general">
          <Field label="Branch prefix" description="New worktree branches start with this.">
            <input aria-label="prefix" />
          </Field>
        </SearchScope>
      </SettingsSearchProvider>,
    );
    expect(screen.getByLabelText<HTMLInputElement>("prefix")).toBe(input);
    expect(input.value).toBe("half-typed");
  });

  it("in spotlight mode marks what the query finds and hides nothing", () => {
    render(
      <SettingsSearchProvider query="cwd" spotlight>
        <SearchScope as="section" section label="General">
          <Field label="Branch prefix">
            <input aria-label="prefix" />
          </Field>
          <Toggle
            label="Follow worktree moves"
            keywords={["cwd"]}
            checked={false}
            onChange={() => {}}
          />
        </SearchScope>
        <SearchScope label="Open in editor" keywords={["cwd"]}>
          <Field label="Command">
            <input aria-label="command" />
          </Field>
        </SearchScope>
      </SettingsSearchProvider>,
    );
    expect(document.querySelectorAll("[hidden], [data-setting-match]")).toHaveLength(0);
    expect(document.querySelector("section")!.className).not.toContain("hidden");
    const spotlit = [...document.querySelectorAll("[data-setting-spotlight]")];
    expect(spotlit.map((el) => el.textContent)).toEqual(["Follow worktree moves", "Command"]);
  });

  it("renders the empty state for any query, leaving its visibility to CSS", () => {
    page("  zzzz ");
    expect(screen.getByTestId("settings-search-empty").textContent).toBe(
      "No settings match “zzzz”.",
    );
  });

  it("finds a shortcut by its name, under its group and the Keyboard heading", () => {
    keyboard("find in thread");
    expect(shown()).toEqual(["binding-thread.find"]);
    expect(screen.getByTestId("binding-thread.find").hasAttribute("data-setting-match")).toBe(true);
    cleanup();

    keyboard("Search settings");
    expect(shown()).toEqual(["binding-settings.search"]);
    cleanup();

    // The heading names every row; a group's name names that group's.
    keyboard("keyboard");
    expect(document.querySelectorAll("li[hidden]")).toHaveLength(0);
    cleanup();

    keyboard("composer");
    expect(shown()).toContain("binding-draft.create");
    expect(shown()).not.toContain("binding-thread.find");
  });
});

/** Two pages as the Settings layout lays them out while searching. */
const twoPages = (query: string) =>
  render(
    <div data-testid="results">
      <SettingsSearchProvider query={query}>
        <SearchScope as="section" section label="General" data-settings-page="/settings/general">
          <Toggle
            label="Keep running in tray"
            keywords={["menu bar"]}
            checked
            onChange={() => {}}
          />
        </SearchScope>
      </SettingsSearchProvider>
      <SettingsSearchProvider query={query}>
        <SearchScope as="section" section label="Advanced" data-settings-page="/settings/storage">
          <Field label="Remove after (days)" keywords={["worktree", "disk"]}>
            <input aria-label="days" />
          </Field>
        </SearchScope>
      </SettingsSearchProvider>
    </div>,
  );

describe("jumping to a match", () => {
  it("opens the page of the first row the search finds, by label or keyword", () => {
    twoPages("tray");
    expect(firstMatchedPage(screen.getByTestId("results"))).toBe("/settings/general");
    cleanup();

    twoPages("disk");
    expect(firstMatchedPage(screen.getByTestId("results"))).toBe("/settings/storage");
    cleanup();

    twoPages("keep");
    expect(firstMatchedPage(screen.getByTestId("results"))).toBe("/settings/general");
    cleanup();

    twoPages("nothing here");
    expect(firstMatchedPage(screen.getByTestId("results"))).toBeUndefined();
  });

  it("goes on Enter while something is typed, and never while composing", () => {
    const onSubmit = vi.fn();
    const onQueryChange = vi.fn();
    const box = (query: string) => (
      <SettingsSearchBox
        query={query}
        onQueryChange={onQueryChange}
        onLeave={() => {}}
        onSubmit={onSubmit}
        inputRef={createRef<HTMLInputElement>()}
      />
    );
    const view = render(box(""));
    const input = screen.getByRole("textbox", { name: "Search settings" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();

    view.rerender(box("limit"));
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();

    // Esc still clears rather than going anywhere.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onQueryChange).toHaveBeenCalledWith("");
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

describe("settingsPagesFor", () => {
  it.each([
    ["win32", true],
    ["darwin", false],
    ["linux", false],
    [undefined, true],
  ])("on %s lists and searches Terminal: %s", (platform, listed) => {
    const ids = settingsPagesFor(platform).map((settingsPage) => settingsPage.id);
    expect(ids.includes("terminal")).toBe(listed);
    expect(ids).toContain("general");
  });
});

describe("listedSettingsPages", () => {
  it("lists the local settings pages", () => {
    const ids = listedSettingsPages(settingsPagesFor(undefined), undefined).map(
      (settingsPage) => settingsPage.id,
    );
    expect(ids).toContain("agents");
    expect(ids).toContain("updates");
  });
});
