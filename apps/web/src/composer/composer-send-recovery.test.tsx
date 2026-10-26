// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useDraftStore } from "@/stores/drafts";
import { useThreadsStore } from "@/stores/threads";

import { Composer } from "./composer";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const THREAD = "t-send-recovery" as ThreadId;
const OTHER = "t-other-draft" as ThreadId;
const setup = () => {
  // Offline discovery/auth are explicitly unavailable; only controlled RPCs accept input.
  sessionStorage.setItem("gram.mock.sessionExpired", "0");
  sessionStorage.setItem("gram.mock.agentRuntimes", JSON.stringify({ agents: [] }));
  sessionStorage.setItem(
    "gram.mock.launchChecks",
    JSON.stringify({
      tools: [],
      claudeSignIn: "notSignedIn",
      codexSignIn: "notSignedIn",
      ghSignedIn: false,
      agentsInUse: [],
    }),
  );
  useServerSettings.setState({ settings: DEFAULT_SETTINGS });
  useThreadsStore.setState({
    byId: {
      [THREAD]: {
        status: "running",
        capabilities: { steer: true },
        thread: { id: THREAD, checkout: { path: "/invented/repo" } },
      },
    } as never,
  });
  useDraftStore.getState().setText(OTHER, "Other thread's draft");
  const api = createMockApi({ speed: 0, autoplay: false, agents: [], persist: false });
  const upload = vi.spyOn(api, "uploadAttachment").mockImplementation(async (_, file) => ({
    path: `/invented/attachments/${file.name}`,
    name: file.name,
    mediaType: file.mediaType,
  }));
  const send = vi.spyOn(api, "send").mockResolvedValue({ queued: true });
  const steer = vi.spyOn(api, "steer").mockResolvedValue(undefined);
  renderWithApi(<Composer threadId={THREAD} focused />, api);
  const textarea = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
  const paste = async (name: string) => {
    fireEvent.paste(textarea, {
      clipboardData: {
        files: [new File(["invented notes"], name, { type: "text/plain" })],
        getData: () => "",
      },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `Remove ${name}` })).toBeTruthy(),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("attachment-chip")
          .every((chip) => chip.getAttribute("data-status") === "ready"),
      ).toBe(true),
    );
  };
  return { api, send, steer, upload, textarea, paste };
};
const queue = () => fireEvent.click(screen.getByRole("button", { name: /^Queue$/ }));
const newDraft = () => {
  fireEvent.contextMenu(screen.getByTestId("send-menu-trigger"));
  fireEvent.click(screen.getByRole("menuitem", { name: /Send and start a new draft/ }));
};
afterEach(() => {
  cleanup();
  useDraftStore.setState({ text: {}, edits: {} });
  useThreadsStore.setState({ byId: {} });
  vi.restoreAllMocks();
  navigate.mockClear();
});

describe("failed send draft recovery", () => {
  it("restores original attachment references alongside a newer draft, then retries once", async () => {
    const { send, upload, textarea, paste } = setup();
    const pending = Promise.withResolvers<{ queued: boolean }>();
    send.mockReturnValueOnce(pending.promise);
    fireEvent.change(textarea, { target: { value: "First direction" } });
    await paste("first.txt");
    queue();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const original = send.mock.calls[0]![1].attachments![0]!;
    expect(textarea.value).toBe("");
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
    fireEvent.change(textarea, { target: { value: "Newer direction" } });
    await paste("newer.txt");
    await act(async () => pending.reject(new Error("synthetic offline refusal")));
    expect(textarea.value).toBe("First direction\n\nNewer direction");
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Remove first.txt" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove newer.txt" })).toBeTruthy();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(useDraftStore.getState().text[OTHER]).toBe("Other thread's draft");
    queue();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![1]).toEqual({
      text: "First direction\n\nNewer direction",
      attachments: expect.arrayContaining([
        original,
        expect.objectContaining({ name: "newer.txt" }),
      ]),
    });
    expect(send.mock.calls[1]![1].attachments).toHaveLength(2);
    expect(textarea.value).toBe("");
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("restores an attachment-only draft when rewind fails without sending", async () => {
    const { api, send, textarea, paste } = setup();
    useDraftStore
      .getState()
      .startEdit(THREAD, "", { messageId: "old-message" as never, files: false });
    const rewind = vi
      .spyOn(api, "rewind")
      .mockRejectedValueOnce(new Error("synthetic rewind refusal"));
    await paste("only.txt");
    queue();
    await waitFor(() =>
      expect(screen.getByText(/Couldn't send: synthetic rewind refusal/)).toBeTruthy(),
    );
    expect(rewind).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
    expect(screen.getByRole("button", { name: "Remove only.txt" })).toBeTruthy();
    expect(useDraftStore.getState().edits[THREAD]).toBeDefined();
  });

  it("returns steer attachments exactly once through the same recovery path", async () => {
    const { steer, paste } = setup();
    steer.mockRejectedValueOnce(new Error("synthetic steer refusal"));
    await paste("steer.txt");
    fireEvent.click(screen.getByRole("button", { name: "Steer now" }));
    await waitFor(() => expect(screen.getByText(/Couldn't steer/)).toBeTruthy());
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(1);
    expect(steer.mock.calls[0]![1].attachments).toHaveLength(1);
  });

  it("stays in the thread after Send and start a new draft fails, then navigates on success", async () => {
    const { send, textarea, paste } = setup();
    send.mockRejectedValueOnce(new Error("synthetic send refusal"));
    fireEvent.change(textarea, { target: { value: "Keep this draft" } });
    await paste("keep.txt");
    newDraft();
    await waitFor(() =>
      expect(screen.getByText(/Couldn't send: synthetic send refusal/)).toBeTruthy(),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Keep this draft");
    expect(screen.getByRole("button", { name: "Remove keep.txt" })).toBeTruthy();
    newDraft();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/new" }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1].attachments).toEqual(send.mock.calls[0]![1].attachments);
  });
});
