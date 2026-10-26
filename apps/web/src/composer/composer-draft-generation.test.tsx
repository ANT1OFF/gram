// @vitest-environment happy-dom
// Faithful independent PR110 generation oracles; explicit snapshot fixtures never emit removals.
import {
  DEFAULT_SETTINGS,
  type ThreadId,
  type Attachment,
  type DraftStash,
  type ThreadSummary,
} from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { runShortcut } from "@/keyboard/registry";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useDraftStore } from "@/stores/drafts";
import { useThreadsStore } from "@/stores/threads";
import { useDiffCommentsStore } from "@/stores/diff-comments";
import { Composer } from "@/composer/composer";
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
const A = "t-independent110-a" as ThreadId,
  B = "t-independent110-b" as ThreadId;
const summary = (id: ThreadId, createdAt: number) =>
  ({
    thread: { id, createdAt, checkout: { path: "/invented/repo" } },
    status: "running",
    capabilities: { steer: true },
    queue: [],
    pendingRequests: [],
  }) as unknown as ThreadSummary;
const field = () => screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const stash = () => {
  act(() => field().focus());
  act(() => expect(runShortcut("composer.stash")).toBe(true));
};
const paste = async (name: string, ready = true) => {
  fireEvent.paste(field(), {
    clipboardData: {
      files: [new File(["Invented bytes"], name, { type: "text/plain" })],
      getData: () => "",
    },
  });
  await waitFor(() => expect(screen.getByRole("button", { name: `Remove ${name}` })).toBeTruthy());
  if (ready)
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("attachment-chip")
          .every((c) => c.getAttribute("data-status") === "ready"),
      ).toBe(true),
    );
};

const fixture = (saved: readonly DraftStash[] = []) => {
  navigate.mockClear();
  sessionStorage.setItem("gram.mock.agents", "");
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
  useThreadsStore.setState({ ready: true, byId: { [A]: summary(A, 10), [B]: summary(B, 10) } });
  const api = createMockApi({ speed: 0, autoplay: false, agents: [], persist: false });
  vi.spyOn(api, "listStashes").mockResolvedValue(saved);
  const upload = vi.spyOn(api, "uploadAttachment").mockImplementation(async (target, file) => ({
    path: `/invented/${"threadId" in target ? target.threadId : target.draftId}/${file.name}`,
    name: file.name,
    mediaType: file.mediaType,
  }));
  const send = vi.spyOn(api, "send").mockResolvedValue({ queued: true });
  const steer = vi.spyOn(api, "steer").mockResolvedValue(undefined);
  const stashDraft = vi.spyOn(api, "stashDraft");
  let view = renderWithApi(<Composer threadId={A} focused />, api);
  const switchTo = (id: ThreadId) => {
    view.unmount();
    view = renderWithApi(<Composer threadId={id} focused />, api);
  };
  const snapshot = (at: number, includeA = true) =>
    act(() =>
      useThreadsStore.getState().applyEvent({
        type: "threads.snapshot",
        threads: [...(includeA ? [summary(A, at)] : []), summary(B, 10)],
      }),
    );
  return { api, upload, send, steer, stashDraft, paste, switchTo, snapshot };
};
afterEach(async () => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
  useDraftStore.setState({ text: {}, edits: {} });
  useDiffCommentsStore.setState({ byThread: {} });
  await act(async () => {});
  vi.restoreAllMocks();
});
it("repair oracle: pending stash success conserves newer text and exact file ref", async () => {
  const s = fixture(),
    p = Promise.withResolvers<DraftStash>();
  s.stashDraft.mockReturnValue(p.promise);
  type("Old A");
  await s.paste("old.txt");
  stash();
  type("New B");
  await s.paste("new.txt");
  await act(async () =>
    p.resolve({ ...s.stashDraft.mock.calls[0]![1], threadId: A, createdAt: 20 }),
  );
  expect(field().value).toBe("New B");
  expect(screen.getAllByTestId("attachment-chip").map((c) => c.getAttribute("title"))).toEqual([
    `/invented/${A}/new.txt`,
  ]);
});
it("repair oracle: unsent exact ref survives a separated remount", async () => {
  const s = fixture();
  type("Keep");
  await s.paste("keep.txt");
  s.switchTo(B);
  await act(async () => {});
  s.switchTo(A);
  expect(field().value).toBe("Keep");
  expect(screen.getAllByTestId("attachment-chip").map((c) => c.getAttribute("title"))).toEqual([
    `/invented/${A}/keep.txt`,
  ]);
});
it("repair oracle: late failed send recovers original refs across remount plus newer uploading file", async () => {
  const s = fixture(),
    p = Promise.withResolvers<Awaited<ReturnType<typeof s.send>>>(),
    u = Promise.withResolvers<Attachment>();
  s.send.mockReturnValueOnce(p.promise);
  type("Sent A");
  await s.paste("old.txt");
  fireEvent.click(screen.getByRole("button", { name: "Queue" }));
  await waitFor(() => expect(s.send).toHaveBeenCalledTimes(1));
  s.switchTo(B);
  s.switchTo(A);
  type("New B");
  s.upload.mockReturnValueOnce(u.promise);
  await s.paste("new.txt", false);
  s.switchTo(B);
  await act(async () => p.reject(new Error("invented refusal")));
  s.switchTo(A);
  expect(field().value).toBe("Sent A\n\nNew B");
  expect(screen.getAllByTestId("attachment-chip")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Queue" }).hasAttribute("disabled")).toBe(true);
  await act(async () => u.resolve({ path: "/invented/new-ready.txt", name: "new.txt" }));
  expect(
    screen
      .getAllByTestId("attachment-chip")
      .every((c) => c.getAttribute("data-status") === "ready"),
  ).toBe(true);
});
it("countercontrol: same-lifetime snapshot conserves files and pending rollback", async () => {
  const s = fixture(),
    p = Promise.withResolvers<Awaited<ReturnType<typeof s.send>>>();
  s.send.mockReturnValueOnce(p.promise);
  type("Old");
  await s.paste("old.txt");
  fireEvent.click(screen.getByRole("button", { name: "Queue" }));
  await waitFor(() => expect(s.send).toHaveBeenCalledTimes(1));
  s.switchTo(B);
  s.snapshot(10);
  s.switchTo(A);
  type("New");
  await s.paste("new.txt");
  await act(async () => p.reject(new Error("invented refusal")));
  expect(field().value).toBe("Old\n\nNew");
  expect(screen.getAllByTestId("attachment-chip")).toHaveLength(2);
});
it.each(["send", "steer", "stash"] as const)(
  "generation oracle: missed close/reopen snapshot fences late %s rollback",
  async (operation) => {
    const s = fixture(),
      p = Promise.withResolvers<never>();
    s[operation === "stash" ? "stashDraft" : operation].mockReturnValueOnce(p.promise);
    type("Old lifetime");
    await s.paste("old.txt");
    if (operation === "stash") stash();
    else
      fireEvent.click(
        screen.getByRole("button", {
          name: operation === "send" ? "Queue" : "Steer now",
        }),
      );
    await waitFor(() =>
      expect(s[operation === "stash" ? "stashDraft" : operation]).toHaveBeenCalledTimes(1),
    );
    s.switchTo(B);
    type("Other unchanged");
    await s.paste("other.txt");
    s.snapshot(20);
    s.switchTo(A);
    type("Reopened lifetime");
    await s.paste("new.txt");
    await act(async () => p.reject(new Error("invented old-generation refusal")));
    expect(field().value).toBe("Reopened lifetime");
    expect(screen.getAllByTestId("attachment-chip").map((c) => c.getAttribute("title"))).toEqual([
      `/invented/${A}/new.txt`,
    ]);
    s.switchTo(B);
    expect(field().value).toBe("Other unchanged");
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(1);
  },
);
it("generation oracle: missed close/reopen snapshot drops old unsent uploads before late settlement", async () => {
  const s = fixture(),
    p = Promise.withResolvers<Attachment>();
  s.upload.mockReturnValueOnce(p.promise);
  await s.paste("old.txt", false);
  await waitFor(() => expect(s.upload).toHaveBeenCalledTimes(1));
  s.switchTo(B);
  s.snapshot(20);
  await act(async () => p.resolve({ path: "/invented/old-upload.txt", name: "old.txt" }));
  s.switchTo(A);
  expect(screen.queryByTestId("attachment-chip")).toBeNull();
});
it("countercontrol: removal snapshot fences rollback without affecting another thread", async () => {
  const s = fixture(),
    p = Promise.withResolvers<Awaited<ReturnType<typeof s.send>>>();
  s.send.mockReturnValueOnce(p.promise);
  type("Old");
  await s.paste("old.txt");
  fireEvent.click(screen.getByRole("button", { name: "Queue" }));
  await waitFor(() => expect(s.send).toHaveBeenCalledTimes(1));
  s.switchTo(B);
  type("Other");
  await s.paste("other.txt");
  s.snapshot(20, false);
  await act(async () => p.reject(new Error("invented refusal")));
  expect(field().value).toBe("Other");
  expect(useDraftStore.getState().text[A]).toBe("");
  expect(screen.getAllByTestId("attachment-chip")).toHaveLength(1);
});

it("generation claim oracle: an old stash cannot block the reopened lifetime after a reconnect snapshot", async () => {
  const s = fixture(),
    old = Promise.withResolvers<DraftStash>(),
    next = Promise.withResolvers<DraftStash>();
  s.stashDraft.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  type("Old");
  await s.paste("old.txt");
  stash();
  expect(s.stashDraft).toHaveBeenCalledTimes(1);
  s.switchTo(B);
  s.snapshot(20);
  s.switchTo(A);
  type("New");
  await s.paste("new.txt");
  stash();
  expect(s.stashDraft).toHaveBeenCalledTimes(2);
  await act(async () => old.reject(new Error("old refusal")));
  type("Next");
  stash();
  expect(s.stashDraft).toHaveBeenCalledTimes(2);
  await act(async () =>
    next.resolve({ ...s.stashDraft.mock.calls[1]![1], threadId: A, createdAt: 20 }),
  );
  expect(field().value).toBe("Next");
});

it.each(["send", "steer", "stash"] as const)(
  "a still-mounted same-ID composer fences old %s rollback and remains usable in the new lifetime",
  async (operation) => {
    const s = fixture();
    const pending = Promise.withResolvers<never>();
    const rpc = s[operation === "stash" ? "stashDraft" : operation];
    rpc.mockReturnValueOnce(pending.promise);
    type("Old lifetime");
    await s.paste("old.txt");
    if (operation === "stash") stash();
    else
      fireEvent.click(
        screen.getByRole("button", {
          name: operation === "send" ? "Queue" : "Steer now",
        }),
      );
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    s.snapshot(20);
    type("New lifetime");
    await s.paste("new.txt");
    await act(async () => pending.reject(new Error("invented old lifetime refusal")));
    expect(field().value).toBe("New lifetime");
    expect(
      screen.getAllByTestId("attachment-chip").map((chip) => chip.getAttribute("title")),
    ).toEqual([`/invented/${A}/new.txt`]);
    expect(screen.queryByText(/invented old lifetime refusal/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(s.send).toHaveBeenCalledTimes(operation === "send" ? 2 : 1));
    expect(s.send.mock.calls.at(-1)![1]).toMatchObject({
      text: "New lifetime",
      attachments: [{ path: `/invented/${A}/new.txt` }],
    });
  },
);

it.each([10, 20])(
  "late successful send-new-draft navigates only in its own lifetime (createdAt %i)",
  async (createdAt) => {
    const s = fixture();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof s.send>>>();
    s.send.mockReturnValueOnce(pending.promise);
    type("Old lifetime");
    await s.paste("old.txt");
    act(() => expect(runShortcut("composer.sendNewDraft")).toBe(true));
    await waitFor(() => expect(s.send).toHaveBeenCalledTimes(1));
    s.snapshot(createdAt);
    type("Keep current draft");
    await s.paste("new.txt");
    await act(async () => pending.resolve({ queued: true }));
    expect(navigate).toHaveBeenCalledTimes(createdAt === 10 ? 1 : 0);
    expect(field().value).toBe("Keep current draft");
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(1);
  },
);

it("a late rewind cannot send into the reopened lifetime or cancel its new edit", async () => {
  const s = fixture();
  const pending = Promise.withResolvers<void>();
  const rewind = vi.spyOn(s.api, "rewind").mockReturnValueOnce(pending.promise);
  act(() =>
    useDraftStore
      .getState()
      .startEdit(A, "Old edit", { messageId: "old-message" as never, files: false }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Queue" }));
  await waitFor(() => expect(rewind).toHaveBeenCalledTimes(1));
  s.snapshot(20);
  act(() =>
    useDraftStore
      .getState()
      .startEdit(A, "New edit", { messageId: "new-message" as never, files: false }),
  );
  await act(async () => pending.resolve());
  expect(s.send).not.toHaveBeenCalled();
  expect(field().value).toBe("New edit");
  expect(useDraftStore.getState().edits[A]?.messageId).toBe("new-message");
});

it.each(["before take", "after take"] as const)(
  "a reopened lifetime fences restoration %s",
  async (phase) => {
    const saved: DraftStash = {
      id: "saved-old" as never,
      threadId: A,
      text: "Saved old",
      attachments: [{ path: "/invented/saved-old.txt", name: "saved-old.txt" }],
      createdAt: 1,
    };
    const s = fixture([saved]);
    const stashing = Promise.withResolvers<DraftStash>();
    const taking = Promise.withResolvers<DraftStash>();
    s.stashDraft.mockReturnValueOnce(stashing.promise);
    const take = vi.spyOn(s.api, "takeStash").mockReturnValueOnce(taking.promise);
    if (phase === "before take") {
      type("Original");
      await s.paste("old.txt");
    }
    fireEvent.click(await screen.findByTestId("stash-trigger"));
    fireEvent.click(await screen.findByRole("button", { name: "Restore draft: Saved old" }));
    if (phase === "before take") expect(s.stashDraft).toHaveBeenCalledTimes(1);
    else await waitFor(() => expect(take).toHaveBeenCalledTimes(1));
    s.snapshot(20);
    type("New lifetime");
    await s.paste("new.txt");
    if (phase === "before take") {
      await act(async () =>
        stashing.resolve({ ...s.stashDraft.mock.calls[0]![1], threadId: A, createdAt: 20 }),
      );
      expect(take).not.toHaveBeenCalled();
    } else await act(async () => taking.resolve(saved));
    expect(field().value).toBe("New lifetime");
    expect(screen.getAllByTestId("attachment-chip").map((c) => c.getAttribute("title"))).toEqual([
      `/invented/${A}/new.txt`,
    ]);
  },
);
