// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SettingRow } from "./fields";

afterEach(cleanup);

describe("a setting's help", () => {
  it("shows its description under the label, which is plain text and not a tab stop", () => {
    render(
      <SettingRow label="Send with" description="Which key sends a message." htmlFor="send">
        <input id="send" />
      </SettingRow>,
    );
    const label = screen.getByText("Send with");
    expect(label.closest("[tabindex]")).toBeNull();
    expect(label.className).not.toContain("underline");
    const line = screen.getByText("Which key sends a message.");
    expect(line.hasAttribute("data-setting-description")).toBe(true);
    expect(line.closest("[data-long-copy]")).toBeNull();
    // Nothing more to say, so no ⓘ.
    expect(screen.queryByTestId("setting-help")).toBeNull();
    // The label still names its control.
    expect(screen.getByRole("textbox", { name: "Send with" })).toBeTruthy();
  });

  it("puts what the line leaves out behind an ⓘ the words describe", () => {
    render(
      <SettingRow
        label="Send with"
        description="Which key sends a message."
        learnMore={<p>Shift+Enter adds a line.</p>}
        htmlFor="send"
      >
        <input id="send" />
      </SettingRow>,
    );
    const trigger = screen.getByTestId("setting-help");
    expect(trigger.getAttribute("tabindex")).toBe("0");
    expect(trigger.getAttribute("data-help-for")).toBe("Send with");
    expect(trigger.getAttribute("aria-label")).toBe("More info");
    const described = document.getElementById(trigger.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("Shift+Enter adds a line.");
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
