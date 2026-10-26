// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, Settings } from "@gram/contracts";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";

import { createMockApi } from "@/api/mock";
import { CommandText } from "@/launch-checks/command-text";

import { useFeature } from "./use-diagnostics";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gram");
  Reflect.deleteProperty(window, "gramMock");
});

describe("local runtime", () => {
  it("renders inline commands as code", () => {
    render(
      <div data-testid="hint">
        <CommandText text="Run `gh auth login`." />
      </div>,
    );
    const hint = screen.getByTestId("hint");
    expect(hint.textContent).toBe("Run gh auth login.");
    expect(hint.querySelector("code")?.textContent).toBe("gh auth login");
  });

  it("keeps explicit stored workspace and update choices", () => {
    const saved = {
      ...DEFAULT_SETTINGS,
      workspaces: { continueAfterRestart: true, worktreeSweep: false },
      updates: { channel: "prerelease", pinnedVersion: "0.1.0-rc.1", automaticChecks: false },
    };
    const decoded = Schema.decodeUnknownSync(Settings)(JSON.parse(JSON.stringify(saved)));
    expect(decoded.workspaces).toEqual(saved.workspaces);
    expect(decoded.updates).toEqual(saved.updates);
    expect(Schema.decodeUnknownSync(Settings)(DEFAULT_SETTINGS).workspaces).toBeUndefined();
  });

  it("keeps shell-dependent features hidden in a plain browser and available in the local mock", () => {
    const { result: browser } = renderHook(() => useFeature("previewPane"));
    expect(browser.current).toBe(false);
    const mock = createMockApi();
    Object.assign(window, { gramMock: mock });
    const { result: preview } = renderHook(() => useFeature("previewPane"));
    const { result: browsing } = renderHook(() => useFeature("agentBrowsingPublic"));
    expect(preview.current).toBe(true);
    expect(browsing.current).toBe(true);
  });
});
