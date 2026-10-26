import { DEFAULT_SETTINGS } from "@gram/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { useServerSettings } from "@/settings-sync/store";

import { fontOverrides, startFontOverrides } from "./font-overrides";

afterEach(() => useServerSettings.setState({ settings: undefined }));

describe("fontOverrides", () => {
  it("quotes a single family and keeps a typed list as is", () => {
    expect(fontOverrides({ ui: "IBM Plex Sans", mono: "Fira Code, monospace" })).toEqual({
      "--font-ui": '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
      "--font-mono": "Fira Code, monospace",
    });
  });

  it("leaves the look's fonts in place when unset or blank", () => {
    expect(fontOverrides({ ui: "  " })).toEqual({
      "--font-ui": undefined,
      "--font-mono": undefined,
    });
    expect(fontOverrides(undefined)["--font-mono"]).toBeUndefined();
  });
});

describe("startFontOverrides", () => {
  it("sets and removes the variables as the setting changes", () => {
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
    const stop = startFontOverrides(root);

    useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, fonts: { mono: "Iosevka" } } });
    expect(properties.get("--font-mono")).toBe(
      '"Iosevka", ui-monospace, "SF Mono", Menlo, monospace',
    );
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    expect(properties.has("--font-mono")).toBe(false);
    stop();
  });
});
