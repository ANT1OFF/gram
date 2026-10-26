// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type DraftStash, type ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { runShortcut } from "@/keyboard/registry";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useDraftStore } from "@/stores/drafts";
import { useThreadsStore } from "@/stores/threads";

import { Composer } from "./composer";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
const A = "t-lifecycle-a" as ThreadId;
const B = "t-lifecycle-b" as ThreadId;
const field = () => screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
const queue = () => fireEvent.click(screen.getByRole("button", { name: /^Queue$/ }));
const stash = () => {
  act(() => field().focus());
  act(() => {
    expect(runShortcut("composer.stash")).toBe(true);
  });
};
const paste = async (name: string, ready = true) => {
  fireEvent.paste(field(), {
    clipboardData: {
      files: [new File(["Invented notes"], name, { type: "text/plain" })],
      getData: () => "",
    },
  });
  await waitFor(() => expect(screen.getByRole("button", { name: `Remove ${name}` })).toBeTruthy());
  if (ready)
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("attachment-chip")
          .every((chip) => chip.getAttribute("data-status") === "ready"),
      ).toBe(true),
    );
};

const setup = (saved: readonly DraftStash[] = []) => {
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
    byId: Object.fromEntries(
      [A, B].map((id) => [
        id,
        {
          status: "running",
          capabilities: { steer: true },
          thread: { id, checkout: { path: "/invented/repo" } },
        },
      ]),
    ) as never,
  });
  const api = createMockApi({ speed: 0, autoplay: false, agents: [], persist: false });
  const upload = vi.spyOn(api, "uploadAttachment").mockImplementation(async (target, file) => ({
    path: `/invented/attachments/${"threadId" in target ? target.threadId : target.draftId}/${file.name}`,
    name: file.name,
    mediaType: file.mediaType,
  }));
  vi.spyOn(api, "listStashes").mockResolvedValue(saved);
  const send = vi.spyOn(api, "send").mockResolvedValue({ queued: true });
  const steer = vi.spyOn(api, "steer").mockResolvedValue(undefined);
  const stashDraft = vi.spyOn(api, "stashDraft");
  const pending = Promise.withResolvers<DraftStash>();
  stashDraft.mockReturnValue(pending.promise);
  let view = renderWithApi(<Composer threadId={A} focused />, api);
  const switchTo = (threadId: ThreadId) => {
    view.unmount();
    view = renderWithApi(<Composer threadId={threadId} focused />, api);
  };
  const finishStash = async () => {
    await act(async () =>
      pending.resolve({ ...stashDraft.mock.calls[0]![1], threadId: A, createdAt: 1 }),
    );
  };
  return { api, upload, send, steer, stashDraft, pending, paste, switchTo, finishStash };
};
afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
  useDraftStore.setState({ text: {}, edits: {} });
  vi.restoreAllMocks();
});

describe("composer draft lifetime", () => {
  it("stash completion conserves newer text and files while storing only the captured draft", async () => {
    const s = setup();
    type("Draft A");
    await s.paste("a.txt");
    stash();
    type("Draft B");
    await s.paste("b.txt");
    await s.finishStash();
    expect(field().value).toBe("Draft B");
    expect(screen.getByRole("button", { name: "Remove b.txt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove a.txt" })).toBeNull();
    expect(s.stashDraft).toHaveBeenCalledTimes(1);
    expect(s.stashDraft.mock.calls[0]![1]).toMatchObject({
      text: "Draft A",
      attachments: [expect.objectContaining({ name: "a.txt" })],
    });
  });

  it("consumes an unchanged stash once and excludes repeated stash/send of the captured draft", async () => {
    const s = setup();
    type("Draft A");
    await s.paste("a.txt");
    stash();
    stash();
    queue();
    await s.finishStash();
    expect(s.stashDraft).toHaveBeenCalledTimes(1);
    expect(s.send).not.toHaveBeenCalled();
    expect(field().value).toBe("");
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("recovers a failed stash beside the newer draft after switching threads", async () => {
    const s = setup();
    type("Draft A");
    await s.paste("a.txt");
    stash();
    s.switchTo(B);
    type("Other thread");
    await s.paste("other.txt");
    s.switchTo(A);
    type("Draft B");
    await s.paste("b.txt");
    s.switchTo(B);
    await act(async () => s.pending.reject(new Error("synthetic stash refusal")));
    expect(field().value).toBe("Other thread");
    expect(screen.queryByRole("button", { name: "Remove a.txt" })).toBeNull();
    s.switchTo(A);
    expect(field().value).toBe("Draft A\n\nDraft B");
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Remove a.txt" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove b.txt" })).toBeTruthy();
    expect(s.upload).toHaveBeenCalledTimes(3);
  });

  it("retains uploads through a remount and ignores completion of a removed upload", async () => {
    const s = setup();
    const pendingUpload =
      Promise.withResolvers<Awaited<ReturnType<typeof s.api.uploadAttachment>>>();
    s.upload.mockReturnValueOnce(pendingUpload.promise);
    await s.paste("pending.txt", false);
    await waitFor(() => expect(s.upload).toHaveBeenCalledTimes(1));
    s.switchTo(B);
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
    s.switchTo(A);
    expect(screen.getByTestId("attachment-chip").getAttribute("data-status")).toBe("uploading");
    fireEvent.click(screen.getByRole("button", { name: "Remove pending.txt" }));
    await act(async () =>
      pendingUpload.resolve({ path: "/invented/pending.txt", name: "pending.txt" }),
    );
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
    s.switchTo(B);
    s.switchTo(A);
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it.each(["send", "steer"] as const)(
    "recovers failed %s refs to its original thread after leaving, then retries exactly once",
    async (operation) => {
      const s = setup();
      const pending = Promise.withResolvers<never>();
      s[operation].mockReturnValueOnce(pending.promise);
      type("First draft");
      await s.paste("first.txt");
      if (operation === "send") queue();
      else fireEvent.click(screen.getByRole("button", { name: "Steer now" }));
      await waitFor(() => expect(s[operation]).toHaveBeenCalledTimes(1));
      const original = s[operation].mock.calls[0]![1].attachments![0]!;
      s.switchTo(B);
      type("Other thread");
      await s.paste("other.txt");
      s.switchTo(A);
      type("Newer draft");
      await s.paste("newer.txt");
      s.switchTo(B);
      await act(async () => pending.reject(new Error("synthetic send refusal")));
      expect(field().value).toBe("Other thread");
      expect(screen.queryByRole("button", { name: "Remove first.txt" })).toBeNull();
      s.switchTo(A);
      expect(field().value).toBe("First draft\n\nNewer draft");
      expect(screen.getAllByTestId("attachment-chip")).toHaveLength(2);
      queue();
      await waitFor(() => expect(s.send).toHaveBeenCalledTimes(operation === "send" ? 2 : 1));
      const retry = s.send.mock.calls.at(-1)!;
      expect(retry[0]).toBe(A);
      expect(retry[1].attachments).toHaveLength(2);
      expect(retry[1].attachments).toContainEqual(original);
      expect(s.upload).toHaveBeenCalledTimes(3);
      s.switchTo(B);
      s.switchTo(A);
      expect(screen.queryByTestId("attachment-chip")).toBeNull();
    },
  );

  it("stash success leaves a newer uploading chip and never resurrects it after removal", async () => {
    const s = setup();
    type("Draft A");
    stash();
    const pendingUpload =
      Promise.withResolvers<Awaited<ReturnType<typeof s.api.uploadAttachment>>>();
    s.upload.mockReturnValueOnce(pendingUpload.promise);
    type("Draft B");
    await s.paste("b.txt", false);
    await waitFor(() => expect(s.upload).toHaveBeenCalledTimes(1));
    await s.finishStash();
    expect(field().value).toBe("Draft B");
    expect(screen.getByTestId("attachment-chip").getAttribute("data-status")).toBe("uploading");
    fireEvent.click(screen.getByRole("button", { name: "Remove b.txt" }));
    await act(async () => pendingUpload.resolve({ path: "/invented/b.txt", name: "b.txt" }));
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });
});

describe("composer transaction ordering", () => {
  it.each([true, false])(
    "an earlier stash completion never consumes a newer failed send (stash succeeds: %s)",
    async (succeeds) => {
      const s = setup();
      type("A");
      await s.paste("a.txt");
      stash();
      type("B");
      await s.paste("b.txt");
      const send = Promise.withResolvers<{ queued: boolean }>();
      s.send.mockReturnValueOnce(send.promise);
      queue();
      await waitFor(() => expect(s.send).toHaveBeenCalledTimes(1));
      type("C");
      await s.paste("c.txt");
      s.switchTo(B);
      await act(async () => send.reject(new Error("synthetic newer send refusal")));
      if (succeeds) await s.finishStash();
      else await act(async () => s.pending.reject(new Error("synthetic earlier stash refusal")));
      s.switchTo(A);
      expect(field().value).toBe(succeeds ? "B\n\nC" : "A\n\nB\n\nC");
      expect(screen.getAllByTestId("attachment-chip")).toHaveLength(succeeds ? 2 : 3);
      expect(s.stashDraft).toHaveBeenCalledTimes(1);
      expect(s.send.mock.calls[0]![1]).toMatchObject({
        text: "B",
        attachments: [expect.objectContaining({ name: "b.txt" })],
      });
      expect(s.upload).toHaveBeenCalledTimes(3);
    },
  );

  it("stash exclusion survives remount and a later explicit stash consumes only the newer draft", async () => {
    const s = setup();
    type("A");
    await s.paste("a.txt");
    stash();
    s.switchTo(B);
    s.switchTo(A);
    type("B");
    await s.paste("b.txt");
    stash();
    expect(s.stashDraft).toHaveBeenCalledTimes(1);
    await s.finishStash();
    expect(field().value).toBe("B");
    s.stashDraft.mockImplementation(async (threadId, draft) => ({
      ...draft,
      threadId,
      createdAt: 2,
    }));
    stash();
    await waitFor(() => expect(s.stashDraft).toHaveBeenCalledTimes(2));
    expect(s.stashDraft.mock.calls[1]![1]).toMatchObject({
      text: "B",
      attachments: [expect.objectContaining({ name: "b.txt" })],
    });
    expect(field().value).toBe("");
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("restoring a saved draft preserves edits made during both stash and take RPCs after remount", async () => {
    const saved: DraftStash = {
      id: "saved-d" as never,
      threadId: A,
      text: "Saved D",
      attachments: [{ path: "/invented/saved.txt", name: "saved.txt" }],
      createdAt: 1,
    };
    const s = setup([saved]);
    const take = Promise.withResolvers<DraftStash>();
    const takeStash = vi.spyOn(s.api, "takeStash").mockReturnValueOnce(take.promise);
    type("A");
    await s.paste("a.txt");
    fireEvent.click(await screen.findByTestId("stash-trigger"));
    fireEvent.click(await screen.findByRole("button", { name: "Restore draft: Saved D" }));
    expect(s.stashDraft).toHaveBeenCalledTimes(1);
    type("B");
    await s.paste("b.txt");
    await s.finishStash();
    await waitFor(() => expect(takeStash).toHaveBeenCalledTimes(1));
    type("C");
    await s.paste("c.txt");
    s.switchTo(B);
    await act(async () => take.resolve(saved));
    s.switchTo(A);
    expect(field().value).toBe("Saved D\n\nC");
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(3);
    for (const name of ["b.txt", "c.txt", "saved.txt"])
      expect(screen.getByRole("button", { name: `Remove ${name}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove a.txt" })).toBeNull();
    expect(s.upload).toHaveBeenCalledTimes(3);
  });

  it.each(["stash", "send", "steer"] as const)(
    "closing a thread fences a pending %s rollback from a reopened draft",
    async (operation) => {
      const s = setup();
      const pending = Promise.withResolvers<never>();
      if (operation !== "stash") s[operation].mockReturnValueOnce(pending.promise);
      type("Old draft");
      await s.paste("old.txt");
      if (operation === "stash") stash();
      else if (operation === "send") queue();
      else fireEvent.click(screen.getByRole("button", { name: "Steer now" }));
      await waitFor(() =>
        expect(operation === "stash" ? s.stashDraft : s[operation]).toHaveBeenCalledTimes(1),
      );
      s.switchTo(B);
      act(() => useThreadsStore.getState().applyEvent({ type: "thread.removed", threadId: A }));
      act(() =>
        useThreadsStore.getState().applyEvent({
          type: "thread.upsert",
          thread: { id: A, checkout: { path: "/invented/repo" } } as never,
        }),
      );
      s.switchTo(A);
      type("Reopened draft");
      await s.paste("new.txt");
      await act(async () =>
        (operation === "stash" ? s.pending : pending).reject(new Error("synthetic old refusal")),
      );
      expect(field().value).toBe("Reopened draft");
      expect(screen.getAllByTestId("attachment-chip")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Remove new.txt" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remove old.txt" })).toBeNull();
    },
  );
});

it("an old pending stash cannot block or unlock a new stash after thread close/reopen", async () => {
  const s = setup();
  type("Old A");
  await s.paste("a.txt");
  stash();
  s.switchTo(B);
  act(() => useThreadsStore.getState().applyEvent({ type: "thread.removed", threadId: A }));
  act(() =>
    useThreadsStore.getState().applyEvent({
      type: "thread.upsert",
      thread: { id: A, checkout: { path: "/invented/repo" } } as never,
    }),
  );
  s.switchTo(A);
  const newer = Promise.withResolvers<DraftStash>();
  s.stashDraft.mockReturnValueOnce(newer.promise);
  type("New B");
  await s.paste("b.txt");
  stash();
  expect(s.stashDraft).toHaveBeenCalledTimes(2);
  await act(async () => s.pending.reject(new Error("synthetic old refusal")));
  type("Next C");
  await s.paste("c.txt");
  stash();
  expect(s.stashDraft).toHaveBeenCalledTimes(2);
  expect(field().value).toBe("Next C");
  await act(async () =>
    newer.resolve({ ...s.stashDraft.mock.calls[1]![1], threadId: A, createdAt: 2 }),
  );
  expect(field().value).toBe("Next C");
  expect(screen.getByRole("button", { name: "Remove c.txt" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove a.txt" })).toBeNull();
});

it("protects in-flight files in discard requests, then releases that protection after stash success", async () => {
  const path = `/invented/attachments/${A}/a.txt`;
  const saved: DraftStash = {
    id: "other-stash" as never,
    threadId: A,
    text: "Other saved draft",
    attachments: [{ path, name: "a.txt" }],
    createdAt: 1,
  };
  const s = setup([saved]);
  const discard = vi.spyOn(s.api, "removeStash").mockResolvedValue(undefined);
  type("A");
  await s.paste("a.txt");
  stash();
  fireEvent.click(await screen.findByTestId("stash-trigger"));
  fireEvent.click(await screen.findByRole("button", { name: "Discard draft: Other saved draft" }));
  await waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
  expect(discard.mock.calls[0]![2]).toContain(path);
  await s.finishStash();
  fireEvent.click(await screen.findByTestId("stash-trigger"));
  fireEvent.click(await screen.findByRole("button", { name: "Discard draft: Other saved draft" }));
  await waitFor(() => expect(discard).toHaveBeenCalledTimes(2));
  expect(discard.mock.calls[1]![2]).toEqual([]);
});
