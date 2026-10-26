// @vitest-environment happy-dom
import type { AppIconId, DesktopBridge } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AppIconControl } from "./appearance-section";

afterEach(() => {
  cleanup();
  delete (window as { gram?: DesktopBridge }).gram;
});

const renderControl = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AppIconControl />
    </QueryClientProvider>,
  );

it("is absent without a desktop shell that can change its icon", () => {
  renderControl();
  expect(screen.queryByRole("group", { name: "App icon" })).toBeNull();
});

it("shows the shell's icon as chosen and asks the shell to change it", async () => {
  let icon: AppIconId = "gift";
  const appIcon = {
    get: vi.fn(async () => icon),
    set: vi.fn(async (next: AppIconId) => {
      icon = next;
    }),
  };
  (window as { gram?: Partial<DesktopBridge> }).gram = { appIcon };
  renderControl();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Gift rune" }).getAttribute("aria-pressed")).toBe(
      "true",
    ),
  );
  expect(screen.getAllByRole("button")).toHaveLength(4);
  fireEvent.click(screen.getByRole("button", { name: "Sword" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Sword" }).getAttribute("aria-pressed")).toBe("true"),
  );
  expect(appIcon.set).toHaveBeenCalledWith("blade");
  expect(screen.getByRole("button", { name: "Gift rune" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
});
