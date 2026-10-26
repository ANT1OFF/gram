import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  nativeTheme: { themeSource: "system", prefersReducedTransparency: false },
}));

vi.mock("node:fs", () => ({
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
}));
vi.mock("electron", () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [] },
  nativeImage: {},
  nativeTheme: mocks.nativeTheme,
  Notification: {},
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.nativeTheme.themeSource = "system";
});

describe("window appearance bootstrap", () => {
  it.each([undefined, "broken", "{}"])(
    "starts fresh or invalid storage in Neutral Dark (%s)",
    async (saved) => {
      mocks.readFileSync.mockImplementation(() => {
        if (saved === undefined) throw new Error("invented missing file");
        return saved;
      });
      const windows = await import("./windows.ts");
      windows.loadStoredAppearance("/mock/appearance.json");
      expect(windows.themeColors()).toEqual({ background: "#0a0a0a", foreground: "#f5f5f5" });
      expect(mocks.nativeTheme.themeSource).toBe("dark");
      expect(mocks.writeFileSync).not.toHaveBeenCalled();
    },
  );

  it.each(["system", "light", "dark"] as const)(
    "keeps the explicit saved %s appearance without writing it",
    async (mode) => {
      const saved = { background: "#16161e", foreground: "#c0caf5", mode };
      mocks.readFileSync.mockReturnValue(JSON.stringify(saved));
      const windows = await import("./windows.ts");
      windows.loadStoredAppearance("/mock/appearance.json");
      expect(windows.themeColors()).toEqual({
        background: saved.background,
        foreground: saved.foreground,
      });
      expect(mocks.nativeTheme.themeSource).toBe(mode);
      expect(mocks.writeFileSync).not.toHaveBeenCalled();
    },
  );
});
