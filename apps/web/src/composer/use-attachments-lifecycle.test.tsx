// @vitest-environment happy-dom
import type { Attachment, DraftId, ThreadId, ThreadSummary } from "@gram/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api, AttachmentTarget } from "@/api/types";
import { useDraftStore } from "@/stores/drafts";
import { useThreadsStore } from "@/stores/threads";

import { threadAttachmentDraft } from "./attachment-draft";
import { useAttachments } from "./use-attachments";

const T = "t-preview-owner" as ThreadId;
const D = "local-new-draft" as DraftId;
const files = (name = "image.png") =>
  Object.assign([new File(["invented bytes"], name, { type: "image/png" })], {
    item: () => null,
  }) as unknown as FileList;
const fixture = () => {
  // Only the synthetic attachment RPC exists; provider/CLI/auth discovery is explicitly unavailable.
  sessionStorage.setItem("gram.mock.agents", "");
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
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementation(() => `blob:invented-${crypto.randomUUID()}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  useThreadsStore.setState({
    byId: { [T]: { thread: { id: T, createdAt: 10 }, status: "idle" } } as never,
  });
  const upload = vi
    .fn<Api["uploadAttachment"]>()
    .mockImplementation(async (_, file) => ({ path: `/invented/${file.name}`, name: file.name }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider api={{ uploadAttachment: upload } as unknown as Api}>{children}</ApiProvider>
  );
  const mount = (
    target: AttachmentTarget = { threadId: T },
    initial: readonly Attachment[] = [],
    strict = false,
  ) =>
    renderHook(() => useAttachments(target, initial), {
      wrapper: strict
        ? ({ children }: { children: ReactNode }) => (
            <StrictMode>{wrapper({ children })}</StrictMode>
          )
        : wrapper,
    });
  const add = async (view: ReturnType<typeof mount>, ready = true) => {
    act(() => {
      expect(view.result.current.add(files())).toBe(true);
    });
    await waitFor(() => expect(upload).toHaveBeenCalled());
    if (ready) await waitFor(() => expect(view.result.current.items[0]?.status).toBe("ready"));
    return view.result.current.items[0]!.previewUrl!;
  };
  return { create, revoke, upload, mount, add };
};
afterEach(async () => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
  useDraftStore.setState({ text: {}, edits: {} });
  await act(async () => {});
  vi.restoreAllMocks();
});

describe("attachment owner lifetime", () => {
  it("keeps a preview through thread remounts, revokes it only when removed, and prunes the empty owner", async () => {
    const s = fixture();
    const first = s.mount();
    const url = await s.add(first);
    const owner = threadAttachmentDraft(T);
    first.unmount();
    await act(async () => {});
    expect(s.revoke).not.toHaveBeenCalled();
    const second = s.mount();
    expect(second.result.current.items[0]!.previewUrl).toBe(url);
    expect(s.upload).toHaveBeenCalledTimes(1);
    act(() => second.result.current.remove(second.result.current.items[0]!.key));
    expect(s.revoke).toHaveBeenCalledExactlyOnceWith(url);
    second.unmount();
    await act(async () => {});
    expect(owner.active).toBe(false);
    expect(threadAttachmentDraft(T)).not.toBe(owner);
  });

  it("settles an upload into the same thread draft after its first mount leaves", async () => {
    const s = fixture();
    const pending = Promise.withResolvers<Attachment>();
    s.upload.mockReturnValueOnce(pending.promise);
    const first = s.mount();
    const url = await s.add(first, false);
    first.unmount();
    await act(async () => pending.resolve({ path: "/invented/ready.png", name: "image.png" }));
    const second = s.mount();
    expect(second.result.current.ready).toEqual([
      { path: "/invented/ready.png", name: "image.png" },
    ]);
    expect(second.result.current.items[0]!.previewUrl).toBe(url);
    expect(s.revoke).not.toHaveBeenCalled();
  });

  it.each(["remove", "clear"] as const)(
    "late upload completion cannot resurrect a %s or settle a newer same-name upload",
    async (action) => {
      const s = fixture();
      const old = Promise.withResolvers<Attachment>();
      const newer = Promise.withResolvers<Attachment>();
      s.upload.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
      const view = s.mount();
      const oldUrl = await s.add(view, false);
      const oldKey = view.result.current.items[0]!.key;
      act(() =>
        action === "clear" ? view.result.current.clear() : view.result.current.remove(oldKey),
      );
      const nextUrl = await s.add(view, false);
      const newKey = view.result.current.items[0]!.key;
      expect(newKey).not.toBe(oldKey);
      await act(async () => old.resolve({ path: "/invented/stale.png", name: "old.png" }));
      expect(view.result.current.items).toMatchObject([
        { key: newKey, status: "uploading", previewUrl: nextUrl },
      ]);
      await act(async () => newer.resolve({ path: "/invented/new.png", name: "image.png" }));
      expect(view.result.current.ready).toEqual([{ path: "/invented/new.png", name: "image.png" }]);
      expect(s.revoke).toHaveBeenCalledExactlyOnceWith(oldUrl);
    },
  );

  it("a captured failed request retains its preview through remount, restores once, and releases on later removal", async () => {
    const s = fixture();
    const first = s.mount();
    const url = await s.add(first);
    const transfer = first.result.current.capture();
    act(() => first.result.current.clear());
    first.unmount();
    await act(async () => {});
    expect(s.revoke).not.toHaveBeenCalled();
    const second = s.mount();
    act(() => {
      expect(transfer.restore()).toBe(true);
      expect(transfer.restore()).toBe(true);
      transfer.release();
      transfer.release();
    });
    expect(second.result.current.items).toHaveLength(1);
    expect(second.result.current.items[0]!.previewUrl).toBe(url);
    expect(s.upload).toHaveBeenCalledTimes(1);
    expect(s.revoke).not.toHaveBeenCalled();
    act(() => second.result.current.clear());
    expect(s.revoke).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("successful request release revokes its consumed preview and frees an unmounted empty owner", async () => {
    const s = fixture();
    const view = s.mount();
    const url = await s.add(view);
    const owner = threadAttachmentDraft(T);
    const transfer = view.result.current.capture();
    act(() => transfer.consume());
    view.unmount();
    await act(async () => transfer.release());
    expect(s.revoke).toHaveBeenCalledExactlyOnceWith(url);
    expect(owner.active).toBe(false);
    expect(transfer.restore()).toBe(false);
  });

  it("thread removal revokes held previews once and refuses stale restoration into a reopened owner", async () => {
    const s = fixture();
    const view = s.mount();
    const url = await s.add(view);
    const transfer = view.result.current.capture();
    act(() => view.result.current.clear());
    act(() => useThreadsStore.getState().applyEvent({ type: "thread.removed", threadId: T }));
    expect(s.revoke).toHaveBeenCalledExactlyOnceWith(url);
    expect(transfer.active).toBe(false);
    view.unmount();
    useThreadsStore.setState({ byId: { [T]: { thread: { id: T }, status: "idle" } } as never });
    const reopened = s.mount();
    await act(async () => {
      expect(transfer.restore()).toBe(false);
      transfer.release();
    });
    expect(reopened.result.current.items).toEqual([]);
    expect(s.revoke).toHaveBeenCalledTimes(1);
  });

  it("new-thread/task draft owners remain local and their initial carried references stay isolated", async () => {
    const s = fixture();
    const initial = [{ path: "/invented/carried.png", name: "carried.png" }];
    const view = s.mount({ draftId: D }, initial);
    act(() => view.result.current.add(files()));
    await waitFor(() => expect(view.result.current.ready).toHaveLength(2));
    const url = view.result.current.items[1]!.previewUrl!;
    view.unmount();
    await act(async () => {});
    expect(s.revoke).toHaveBeenCalledExactlyOnceWith(url);
    const sameLocalId = s.mount({ draftId: D });
    expect(sameLocalId.result.current.items).toEqual([]);
    const carried = s.mount({ draftId: "different-draft" as DraftId }, initial);
    expect(carried.result.current.ready).toEqual(initial);
    const thread = s.mount();
    expect(thread.result.current.items).toEqual([]);
  });

  it("two panes share one thread owner and unmounting either cannot revoke the other's preview", async () => {
    const s = fixture();
    const first = s.mount();
    const second = s.mount();
    const url = await s.add(first);
    expect(second.result.current.items[0]!.previewUrl).toBe(url);
    first.unmount();
    await act(async () => {});
    expect(s.revoke).not.toHaveBeenCalled();
    act(() => second.result.current.clear());
    expect(s.revoke).toHaveBeenCalledExactlyOnceWith(url);
    expect(s.create).toHaveBeenCalledTimes(1);
  });

  it("Strict Mode subscription replay preserves local files and no attachment state is persisted", async () => {
    const s = fixture();
    const view = s.mount({ draftId: D }, [], true);
    const url = await s.add(view);
    act(() => useDraftStore.getState().setText(T, "Only text is persisted"));
    expect(JSON.parse(sessionStorage.getItem("gram.drafts")!)).toEqual({
      state: { text: { [T]: "Only text is persisted" } },
      version: 1,
    });
    expect(s.revoke).not.toHaveBeenCalled();
    expect(view.result.current.items[0]!.previewUrl).toBe(url);
    view.unmount();
    await act(async () => {});
    expect(s.revoke).toHaveBeenCalledExactlyOnceWith(url);
  });
});

it("releasing an older claim twice cannot unlock a newer transaction", async () => {
  const s = fixture();
  const view = s.mount();
  const first = view.result.current.claim("stash")!;
  expect(first).toBeDefined();
  expect(view.result.current.claim("stash")).toBeUndefined();
  first.release();
  const second = view.result.current.claim("stash")!;
  first.release();
  expect(view.result.current.claim("stash")).toBeUndefined();
  second.release();
  const third = view.result.current.claim("stash")!;
  expect(third).toBeDefined();
  third.release();
});

const snapshot = (createdAt: number) =>
  act(() =>
    useThreadsStore.getState().applyEvent({
      type: "threads.snapshot",
      threads: [{ thread: { id: T, createdAt }, status: "idle" } as ThreadSummary],
    }),
  );

it("a same-lifetime snapshot preserves mounted files, nested transfers and their preview refcounts", async () => {
  const s = fixture();
  const view = s.mount();
  const url = await s.add(view);
  const old = view.result.current;
  const first = old.capture();
  const second = old.capture();
  act(() => old.clear());
  snapshot(10);
  expect(old.active).toBe(true);
  expect(view.result.current.keep).toEqual(["/invented/image.png"]);
  act(() => {
    first.release();
    expect(second.restore()).toBe(true);
    second.release();
  });
  expect(view.result.current.items[0]!.previewUrl).toBe(url);
  expect(s.revoke).not.toHaveBeenCalled();
  act(() => view.result.current.clear());
  expect(s.revoke).toHaveBeenCalledExactlyOnceWith(url);
});

it("a mounted same-ID reopened lifetime replaces its owner, revokes held previews once and isolates action claims", async () => {
  const s = fixture();
  const view = s.mount();
  const url = await s.add(view);
  const old = view.result.current;
  const first = old.claim("stash")!;
  const second = old.capture();
  act(() => first.consume());
  snapshot(20); // No intermediate removal was delivered.
  expect(old.active).toBe(false);
  expect(first.active).toBe(false);
  expect(second.active).toBe(false);
  expect(view.result.current.active).toBe(true);
  expect(view.result.current.items).toEqual([]);
  expect(view.result.current.keep).toEqual([]);
  expect(s.revoke).toHaveBeenCalledExactlyOnceWith(url);
  const newUrl = await s.add(view);
  const next = view.result.current.claim("stash")!;
  expect(next).toBeDefined();
  act(() => {
    expect(first.restore()).toBe(false);
    expect(second.restore()).toBe(false);
    first.release();
    first.release();
    second.release();
  });
  expect(view.result.current.claim("stash")).toBeUndefined();
  expect(view.result.current.items[0]!.previewUrl).toBe(newUrl);
  act(() => {
    next.release();
    view.result.current.clear();
  });
  expect(s.revoke.mock.calls).toEqual([[url], [newUrl]]);
});

it.each(["resolve", "reject"] as const)(
  "a mounted reopened lifetime fences an old upload's %s while its newer upload remains pending",
  async (settle) => {
    const s = fixture();
    const old = Promise.withResolvers<Attachment>();
    const newer = Promise.withResolvers<Attachment>();
    s.upload.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    const view = s.mount();
    const oldUrl = await s.add(view, false);
    snapshot(20);
    expect(view.result.current.items).toEqual([]);
    const newUrl = await s.add(view, false);
    const newKey = view.result.current.items[0]!.key;
    await act(async () =>
      settle === "resolve"
        ? old.resolve({ path: "/invented/old.png", name: "image.png" })
        : old.reject(new Error("invented old upload refusal")),
    );
    expect(view.result.current.items).toMatchObject([
      { key: newKey, status: "uploading", previewUrl: newUrl },
    ]);
    await act(async () => newer.resolve({ path: "/invented/new.png", name: "image.png" }));
    expect(view.result.current.ready).toEqual([{ path: "/invented/new.png", name: "image.png" }]);
    expect(s.revoke).toHaveBeenCalledExactlyOnceWith(oldUrl);
  },
);

it("thread lifetime changes do not replace local new-thread/task owners", async () => {
  const s = fixture();
  const view = s.mount({ draftId: D });
  const url = await s.add(view);
  snapshot(20);
  expect(view.result.current.items[0]!.previewUrl).toBe(url);
  expect(view.result.current.active).toBe(true);
  expect(s.revoke).not.toHaveBeenCalled();
});
