import { DEFAULT_SETTINGS } from "@gram/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { useServerSettings } from "@/settings-sync/store";

import { readingOf, readingVars, startReadingPrefs } from "./reading";

afterEach(() => useServerSettings.setState({ settings: undefined }));

describe("readingVars", () => {
  it("sets the size, its ratio to 14px and the column's width", () => {
    expect(readingVars({ textSize: 21, width: "narrow" })).toEqual({
      "--transcript-text-size": "21px",
      "--transcript-scale": "1.5",
      "--transcript-max-width": "40rem",
    });
    expect(readingVars({ width: "full" })["--transcript-max-width"]).toBe("100%");
  });

  it("leaves the stylesheet's defaults while unset", () => {
    expect(readingVars(readingOf(DEFAULT_SETTINGS))).toEqual({
      "--transcript-text-size": undefined,
      "--transcript-scale": undefined,
      "--transcript-max-width": undefined,
    });
  });
});

describe("startReadingPrefs", () => {
  it("sets and removes the variables as the settings change", () => {
    const properties = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => void properties.set(name, value),
        removeProperty: (name: string) => {
          properties.delete(name);
          return "";
        },
      },
    } as unknown as Pick<HTMLElement, "style">;
    const stop = startReadingPrefs(root);
    expect(properties.size).toBe(0);

    useServerSettings.setState({
      settings: { ...DEFAULT_SETTINGS, reading: { textSize: 16, width: "wide" } },
    });
    expect(properties.get("--transcript-text-size")).toBe("16px");
    expect(properties.get("--transcript-max-width")).toBe("64rem");

    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    expect(properties.size).toBe(0);
    stop();
  });
});
