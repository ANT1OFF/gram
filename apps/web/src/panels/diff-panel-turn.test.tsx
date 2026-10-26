// @vitest-environment happy-dom
import type {
  Diff,
  DiffFile,
  DiffScope,
  GramUIMessage,
  GramUIMessageChunk,
  MessageId,
  ThreadId,
} from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiThreadFeedEvent } from "@/api/types";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { DiffPanel } from "./diff-panel";
import { resetFilesStore } from "./files/files-store";
import { renderWithApi } from "./test-utils";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useThreadsStore.setState({ byId: {} });
  useLayoutStore.setState({ panelTargets: {} });
  resetFilesStore();
});

const MESSAGES = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Bump the deps" }] },
  {
    id: "a1",
    role: "assistant",
    metadata: { turnId: "turn-a" },
    parts: [{ type: "text", text: "Bumped.", state: "done" }],
  },
  { id: "u2", role: "user", parts: [{ type: "text", text: "Fix the lint" }] },
  {
    id: "a2",
    role: "assistant",
    metadata: { turnId: "turn-b" },
    parts: [{ type: "text", text: "Fixed.", state: "done" }],
  },
] as unknown as GramUIMessage[];

const file = (path: string): DiffFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-a\n+b",
  binary: false,
  tooLarge: false,
});

/** The history and catch-up every feed here starts with. */
async function* history(): AsyncIterable<ApiThreadFeedEvent> {
  yield { type: "subscribed" };
  yield { type: "messages", messages: MESSAGES } as ApiThreadFeedEvent;
  yield { type: "caughtUp" } as ApiThreadFeedEvent;
}

async function* threadFeed(
  _threadId: ThreadId,
  signal: AbortSignal,
): AsyncIterable<ApiThreadFeedEvent> {
  yield* history();
  await new Promise((resolve) => signal.addEventListener("abort", resolve));
}

/** A chunk of the reply `a3`. */
const chunk = (c: GramUIMessageChunk): ApiThreadFeedEvent => ({
  type: "chunk",
  messageId: "a3" as MessageId,
  chunk: c,
});

/** Lets the feed deliver what was pushed and the frame after it publish. */
const frame = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

const turnDiff = vi.fn(async (_threadId: ThreadId, scope: DiffScope): Promise<Diff> =>
  scope.kind === "turn"
    ? { repo: true, files: [file(scope.turnId === "turn-a" ? "deps.json" : "lint.ts")] }
    : { repo: true, files: [] },
);

describe("DiffPanel turn scope", () => {
  it("picks among turns latest first, labelled by their prompts", async () => {
    const T = "t-turn-picker" as ThreadId;
    renderWithApi(<DiffPanel threadId={T} />, { gitDiff: turnDiff, threadFeed });

    fireEvent.click(screen.getByRole("radio", { name: "Turn" }));
    const picker = (await screen.findByRole("combobox", { name: "Turn" })) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      "Fix the lint",
      "Bump the deps",
    ]);
    expect(picker.value).toBe("turn-b");
    expect(await screen.findByText("lint.ts")).toBeTruthy();

    fireEvent.change(picker, { target: { value: "turn-a" } });
    expect(await screen.findByText("deps.json")).toBeTruthy();
    expect(turnDiff).toHaveBeenCalledWith(T, { kind: "turn", turnId: "turn-a" });
  });

  it("selects the turn a transcript chip asked for", async () => {
    const T = "t-turn-target" as ThreadId;
    useLayoutStore.setState({
      panelTargets: { diff: { id: 7, threadId: T, target: "turn:turn-a" } },
    });
    renderWithApi(<DiffPanel threadId={T} />, { gitDiff: turnDiff, threadFeed });

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Turn" }).getAttribute("aria-checked")).toBe("true"),
    );
    expect(await screen.findByText("deps.json")).toBeTruthy();
    expect(useLayoutStore.getState().panelTargets.diff).toBeUndefined();
  });

  it("explains a turn without a checkpoint", async () => {
    const T = "t-turn-missing" as ThreadId;
    const gitDiff = vi.fn(async (_threadId: ThreadId, scope: DiffScope): Promise<Diff> => {
      if (scope.kind !== "turn") return { repo: true, files: [] };
      throw {
        _tag: "NotFound",
        entity: "checkpoint",
        id: scope.turnId,
        message: "This turn has no checkpoint, so its changes can't be shown.",
      };
    });
    renderWithApi(<DiffPanel threadId={T} />, { gitDiff, threadFeed });

    fireEvent.click(screen.getByRole("radio", { name: "Turn" }));
    expect(
      await screen.findByText("This turn has no checkpoint, so its changes can't be shown."),
    ).toBeTruthy();
  });

  it("renders nothing again while a reply streams, and offers its turn once it starts", async () => {
    const T = "t-turn-streaming" as ThreadId;
    const queue: ApiThreadFeedEvent[] = [];
    let wake: (() => void) | undefined;
    const push = (...events: ApiThreadFeedEvent[]) => {
      queue.push(...events);
      wake?.();
    };
    async function* liveFeed(
      _threadId: ThreadId,
      signal: AbortSignal,
    ): AsyncIterable<ApiThreadFeedEvent> {
      yield* history();
      while (!signal.aborted) {
        const next = queue.shift();
        if (next !== undefined) yield next;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    }
    let commits = 0;
    renderWithApi(
      <Profiler id="diff" onRender={() => commits++}>
        <DiffPanel threadId={T} />
      </Profiler>,
      { gitDiff: turnDiff, threadFeed: liveFeed },
    );
    fireEvent.click(screen.getByRole("radio", { name: "Turn" }));
    expect(await screen.findByText("lint.ts")).toBeTruthy();

    push(
      {
        type: "message",
        message: {
          id: "u3",
          role: "user",
          metadata: { turnId: "turn-c" },
          parts: [{ type: "text", text: "Tidy the docs" }],
        },
        rev: 2,
      } as ApiThreadFeedEvent,
      chunk({ type: "start", messageId: "a3" }),
      chunk({ type: "text-start", id: "t" }),
    );
    await frame();
    const picker = screen.getByRole("combobox", { name: "Turn" }) as HTMLSelectElement;
    await waitFor(() =>
      expect([...picker.options].map((o) => o.textContent)).toEqual([
        "Tidy the docs",
        "Fix the lint",
        "Bump the deps",
      ]),
    );
    await waitFor(() =>
      expect(turnDiff).toHaveBeenCalledWith(T, { kind: "turn", turnId: "turn-c" }),
    );
    await frame();

    const before = commits;
    for (let i = 0; i < 10; i++) {
      push(chunk({ type: "text-delta", id: "t", delta: `word${i} ` }));
      await frame();
    }
    expect(commits).toBe(before);
  });
});
