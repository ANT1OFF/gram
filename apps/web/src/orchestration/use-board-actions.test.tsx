// @vitest-environment happy-dom
import type { ServerEvent, WorkspaceId } from "@gram/contracts";
import { askQuestion } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useServerEvents } from "@/stores/feeds";

import { useOpenQuestionCounts, useOpenQuestions, useOpenQuestionsOf } from "./use-board-actions";

const W1 = "w1" as WorkspaceId;
const IDS = [W1];

/** A server whose `questions.md` the test writes, and whose event feed it pushes by hand. */
const fakeServer = () => {
  let file: string | undefined;
  const queued: ServerEvent[] = [];
  let wake: (() => void) | undefined;
  const api = {
    readMemory: async (_workspaceId: WorkspaceId, path: string) => {
      if (file === undefined) throw new Error(`${path} isn't in memory.`);
      return { path, content: file };
    },
    events: async function* (signal: AbortSignal) {
      while (!signal.aborted) {
        const next = queued.shift();
        if (next !== undefined) yield next;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  } as unknown as Api;
  return {
    api,
    /** What `ask_user` does: the file is written, then `memory.changed` goes out. */
    ask: (question: string) => {
      const edit = askQuestion(file, { question }, "2026-10-09");
      if (!edit.ok) throw new Error(edit.problem);
      file = edit.content;
      queued.push({ type: "memory.changed", workspaceId: W1 });
      wake?.();
    },
  };
};

afterEach(cleanup);

describe("open questions", () => {
  it("reach the sidebar badge, the Waiting on you section and the tray on memory.changed", async () => {
    const server = fakeServer();
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ApiProvider api={server.api}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </ApiProvider>
    );
    const { result } = renderHook(
      () => {
        useServerEvents();
        return {
          counts: useOpenQuestionCounts(IDS),
          section: useOpenQuestionsOf(IDS),
          tray: useOpenQuestions(W1),
        };
      },
      { wrapper },
    );
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(result.current.counts.get(W1)).toBe(0);

    // Inside the 30 s the reads stay fresh for: only the event can bring it in.
    act(() => server.ask("Ship MSI or MSIX?"));
    await waitFor(() => expect(result.current.counts.get(W1)).toBe(1));
    expect(result.current.section.get(W1)?.map((q) => q.text)).toEqual(["Ship MSI or MSIX?"]);
    expect(result.current.tray.map((q) => q.id)).toEqual(["Q1"]);
  });
});
