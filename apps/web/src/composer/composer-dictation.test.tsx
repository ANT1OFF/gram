// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoreApi, UseBoundStore } from "zustand";

import { createMockApi } from "@/api/mock";
import type { DictationState } from "@/dictation/session";
import * as useDictationModule from "@/dictation/use-dictation";
import { renderWithApi } from "@/panels/test-utils";
import { useDraftStore } from "@/stores/drafts";
import { useThreadsStore } from "@/stores/threads";

import { Composer } from "./composer";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));

interface Heard {
  readonly state: DictationState;
  readonly partial: string;
}

// The session itself needs a microphone and a speech process; its phases and partial are what the
// composer draws from, so the test drives those.
vi.mock("@/dictation/use-dictation", async (importOriginal) => {
  const { create } = await import("zustand");
  const heard = create<Heard>(() => ({ state: { phase: "idle" }, partial: "" }));
  return {
    ...(await importOriginal<typeof useDictationModule>()),
    heard,
    useDictation: () => {
      const { state, partial } = heard();
      const active =
        state.phase === "starting" || state.phase === "listening" || state.phase === "stopping";
      return {
        available: true,
        state,
        partial,
        active,
        level: () => 0,
        toggle: () => {},
        prewarm: () => {},
        stop: () => {},
        cancel: () => heard.setState({ state: { phase: "idle" }, partial: "" }),
      };
    },
  };
});

const { heard } = useDictationModule as unknown as {
  heard: UseBoundStore<StoreApi<Heard>>;
};
const hear = (next: Partial<Heard>) => act(() => heard.setState(next));

const THREAD = "t-dictate" as ThreadId;

const setup = () => {
  useThreadsStore.setState({
    byId: {
      [THREAD]: { status: "idle", thread: { id: THREAD, checkout: { path: "/work/repo" } } },
    } as never,
  });
  renderWithApi(
    <Composer threadId={THREAD} focused />,
    createMockApi({ speed: 0, autoplay: false }),
  );
  return screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
};

afterEach(() => {
  cleanup();
  heard.setState({ state: { phase: "idle" }, partial: "" });
  useThreadsStore.setState({ byId: {} });
  useDraftStore.setState({ text: {} });
});

describe("Composer dictation", () => {
  it("keeps the full local model failure visible after the transient hint would have expired", async () => {
    setup();
    vi.useFakeTimers();
    try {
      const message =
        "The local NVIDIA model could not load. Remove it in Settings → Voice input and download the verified model again.";
      hear({ state: { phase: "starting" } });
      hear({ state: { phase: "error", code: "model-missing", message } });
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(screen.getByRole("alert").textContent).toBe(`Dictation: ${message}`);
      expect(screen.getByTestId("dictation-button").getAttribute("data-state")).toBe("error");
      const field = screen.getByRole("combobox", { name: "Message" });
      fireEvent.change(field, { target: { value: "Keep this draft" } });
      fireEvent.keyDown(field, { key: "Escape" });
      expect(screen.queryByRole("alert")).toBeNull();
      expect((field as HTMLTextAreaElement).value).toBe("Keep this draft");
      hear({ state: { phase: "error", code: "model-missing", message } });
      hear({ state: { phase: "starting" } });
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("hides the placeholder from the start of dictation and brings it back after", () => {
    const textarea = setup();
    expect(textarea.placeholder).toMatch(/^Message…/);

    // Before a word is heard, so the first partial never lands on it.
    hear({ state: { phase: "starting" } });
    expect(textarea.placeholder).toBe("");
    hear({ state: { phase: "listening" } });
    expect(textarea.placeholder).toBe("");
    hear({ partial: "Refactor the" });
    expect(textarea.placeholder).toBe("");
    expect(screen.getByTestId("dictation-partial").textContent).toBe("Refactor the");
    hear({ state: { phase: "stopping" } });
    expect(textarea.placeholder).toBe("");

    hear({ state: { phase: "idle" }, partial: "" });
    expect(textarea.placeholder).toMatch(/^Message…/);
  });

  it("brings the placeholder back after Escape, and after an error", () => {
    const textarea = setup();
    hear({ state: { phase: "listening" }, partial: "Refactor" });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByTestId("dictation-partial")).toBeNull();
    expect(textarea.placeholder).toMatch(/^Message…/);

    hear({ state: { phase: "starting" } });
    hear({ state: { phase: "error", code: "model-missing", message: "No model" } });
    expect(textarea.placeholder).toMatch(/^Message…/);
  });
});
