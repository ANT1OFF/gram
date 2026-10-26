// @vitest-environment happy-dom
import type { Project, ProjectId, Thread, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";

import { CheckoutPrDialog } from "./checkout-pr-dialog";

const openThread = vi.fn();
vi.mock("@/shell/thread-switcher", () => ({ useOpenThread: () => openThread }));

const projects: Project[] = [
  { id: "p-api" as ProjectId, root: "/code/api", name: "api", bookmarked: false },
  { id: "p-web" as ProjectId, root: "/code/web", name: "web", bookmarked: false },
];

afterEach(() => {
  cleanup();
  openThread.mockReset();
});

describe("CheckoutPrDialog", () => {
  it("checks the PR out in the preselected project and opens its thread", async () => {
    const prCheckout = vi.fn(async () => ({ id: "t-new" as ThreadId }) as Thread);
    const onClose = vi.fn();
    renderWithApi(<CheckoutPrDialog projectRoot="/code/web" onClose={onClose} />, {
      listProjects: vi.fn(async () => projects),
      prCheckout,
    });

    await waitFor(() =>
      expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("/code/web"),
    );
    const input = screen.getByRole("textbox", { name: "Pull request number or URL" });
    fireEvent.change(input, { target: { value: "https://github.com/acme/web/pull/7/files" } });
    fireEvent.click(screen.getByRole("button", { name: "Check out" }));

    await waitFor(() => expect(prCheckout).toHaveBeenCalledWith("/code/web", 7, "acme/web"));
    await waitFor(() => expect(openThread).toHaveBeenCalledWith("t-new"));
    expect(onClose).toHaveBeenCalled();
  });

  it("explains an unrecognised reference and a failed checkout", async () => {
    const prCheckout = vi.fn(async () => {
      throw new Error("no pull requests found");
    });
    renderWithApi(<CheckoutPrDialog onClose={vi.fn()} />, {
      listProjects: vi.fn(async () => projects),
      prCheckout,
    });
    const input = screen.getByRole("textbox", { name: "Pull request number or URL" });
    fireEvent.change(input, { target: { value: "not a pr" } });
    expect(screen.getByText(/Type a number like #12/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Check out" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.change(input, { target: { value: "#99" } });
    await waitFor(() =>
      expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("/code/api"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check out" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("no pull requests found"),
    );
    expect(prCheckout).toHaveBeenCalledWith("/code/api", 99, undefined);
    expect(openThread).not.toHaveBeenCalled();
  });
});
