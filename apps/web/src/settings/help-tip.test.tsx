// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingRow } from "./fields";

afterEach(cleanup);

describe("a setting's help", () => {
  it("is on its label, a tab stop the words describe, with no ? beside it", () => {
    render(
      <SettingRow label="Send with" description="Which key sends a message." htmlFor="send">
        <input id="send" />
      </SettingRow>,
    );
    const trigger = screen.getByText("Send with").closest('[data-testid="setting-help"]');
    expect(trigger?.getAttribute("tabindex")).toBe("0");
    expect(trigger?.getAttribute("data-help-for")).toBe("Send with");
    const described = document.getElementById(trigger?.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("Which key sends a message.");
    expect(screen.queryByRole("button", { name: "Help" })).toBeNull();
    // The label still names its control.
    expect(screen.getByRole("textbox", { name: "Send with" })).toBeTruthy();
  });

  it("leaves a label with nothing to say as just its name", () => {
    render(
      <SettingRow label="Send with" htmlFor="send">
        <input id="send" />
      </SettingRow>,
    );
    expect(screen.queryByTestId("setting-help")).toBeNull();
    expect(screen.getByText("Send with").closest("[tabindex]")).toBeNull();
  });
});
