// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { Field, SettingRow } from "./fields";
import { SettingsSearchProvider } from "./search-scope";

afterEach(cleanup);

const rich = (
  <>
    Deploy key <code>ssh-ed25519</code>
  </>
);

const rows = (query = "") =>
  render(
    <TooltipProvider>
      <SettingsSearchProvider query={query}>
        <SettingRow
          label={rich}
          labelText="Deploy key"
          description={
            <>
              Read only. <a href="/docs/keys">How keys work</a>
            </>
          }
          onReset={() => {}}
          learnMore="Rotated every 90 days."
        >
          <button type="button">Rotate</button>
        </SettingRow>
        <Field label="Plain name" description="A plain line.">
          <input aria-label="Plain" />
        </Field>
      </SettingsSearchProvider>
    </TooltipProvider>,
  );

const settingOf = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-setting]")].find((each) =>
    each.textContent?.includes(text),
  )!;

describe("rich setting labels", () => {
  it("draws a name and a line that are more than words", () => {
    rows();
    const row = settingOf("Deploy key");
    expect(row.querySelector("[data-setting-label] code")?.textContent).toBe("ssh-ed25519");
    expect(screen.getByRole("link", { name: "How keys work" })).toBeTruthy();
  });

  it("names the reset and the ⓘ by the label's words", () => {
    rows();
    expect(screen.getByRole("button", { name: "Reset Deploy key to default" })).toBeTruthy();
    expect(
      settingOf("Deploy key").querySelector("[data-help-for]")?.getAttribute("data-help-for"),
    ).toBe("Deploy key");
  });

  it("is found by search through its words, and a string label still is", () => {
    rows("deploy");
    expect(settingOf("Deploy key").hasAttribute("hidden")).toBe(false);
    expect(settingOf("Plain name").hasAttribute("hidden")).toBe(true);
    cleanup();
    rows("plain");
    expect(settingOf("Plain name").hasAttribute("hidden")).toBe(false);
    expect(settingOf("Deploy key").hasAttribute("hidden")).toBe(true);
  });
});
