// @vitest-environment happy-dom
import type { Api } from "@/api/types";
import type { DesktopBridge } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";

import { HelpSection } from "./help-section";

const withBridge = (bridge: Partial<DesktopBridge>) =>
  Object.defineProperty(window, "gram", { value: bridge, configurable: true });

const renderSection = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ApiProvider api={{ diagnostics: async () => new Promise(() => {}) } as unknown as Api}>
        <HelpSection />
      </ApiProvider>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gram");
});

describe("HelpSection acknowledgements", () => {
  it("opens the shipped third-party notices through the desktop bridge", async () => {
    const openAcknowledgements = vi.fn(async () => true);
    withBridge({ platform: "darwin", openAcknowledgements });
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Acknowledgements" }));
    await waitFor(() => expect(openAcknowledgements).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the notices won't open", async () => {
    withBridge({ platform: "darwin", openAcknowledgements: async () => false });
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Acknowledgements" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't open the third-party notices in this install.",
    );
  });

  it("has no link without a shell that ships the notices", () => {
    renderSection();
    expect(screen.queryByRole("button", { name: "Acknowledgements" })).toBeNull();
    withBridge({ platform: "darwin" });
    cleanup();
    renderSection();
    expect(screen.queryByRole("button", { name: "Acknowledgements" })).toBeNull();
  });
});
