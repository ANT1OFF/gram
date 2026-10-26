// @vitest-environment happy-dom
import type { DesktopBridge } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import { createMockApi } from "@/api/mock";

import { CURATED_MONO_FONTS, useInstalledFonts } from "./installed-fonts";

// The desktop's diagnostics, so the font list reads as offered wherever the shell has it.
const api = createMockApi();

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ApiProvider api={api}>{children}</ApiProvider>
  </QueryClientProvider>
);

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gram");
});

describe("useInstalledFonts", () => {
  it("falls back to the curated lists in a browser", () => {
    const { result } = renderHook(() => useInstalledFonts(), { wrapper });
    expect(result.current).toMatchObject({ installed: false, mono: CURATED_MONO_FONTS });
  });

  it("lists the installed families through the desktop bridge", async () => {
    const listFonts = vi.fn(async () => ["Avenir Next", "Menlo"]);
    Object.defineProperty(window, "gram", {
      value: { listFonts } as unknown as DesktopBridge,
      configurable: true,
    });
    const { result } = renderHook(() => useInstalledFonts(), { wrapper });
    await waitFor(() => expect(result.current.installed).toBe(true));
    expect(result.current.ui).toEqual(["Avenir Next", "Menlo"]);
  });

  it("keeps the curated lists when the computer's fonts can't be listed", async () => {
    const listFonts = vi.fn(async () => []);
    Object.defineProperty(window, "gram", {
      value: { listFonts } as unknown as DesktopBridge,
      configurable: true,
    });
    const { result } = renderHook(() => useInstalledFonts(), { wrapper });
    await waitFor(() => expect(listFonts).toHaveBeenCalled());
    expect(result.current.installed).toBe(false);
  });
});
