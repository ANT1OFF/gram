// @vitest-environment happy-dom
import type { GramUIMessage, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, render as renderPlain, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithRouter } from "@/panels/test-utils";
import { useConversationOnly } from "@/stores/conversation-only";

import { isWork, showsInConversation } from "./conversation-only";
import { ConversationOnlyButton } from "./conversation-only-toggle";
import { MessageBlock } from "./message-block";
import { WorkingLine } from "./working-line";

const T = "t-conversation" as ThreadId;

const bash = (id: string, command: string) =>
  ({
    type: "tool-Bash",
    toolCallId: id,
    state: "output-available",
    input: { command },
    output: "ok",
  }) as GramUIMessage["parts"][number];

const reply = (id: string, parts: GramUIMessage["parts"]): GramUIMessage => ({
  id,
  role: "assistant",
  parts,
});

const render = (message: GramUIMessage, api: object = {}) =>
  renderWithRouter(
    <MessageBlock
      threadId={T}
      message={message}
      streamingIds={new Set()}
      subagents={new Map()}
      subagentUsage={new Map()}
    />,
    api as never,
  );

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const STORED = "/data/attachments/t-conversation/tool-0123456789abcdef.png";
/** A screenshot a tool call returned: the call, then the image the server stored for it. */
const screenshot = (id: string): GramUIMessage["parts"] => [
  {
    type: "tool-Read",
    toolCallId: id,
    state: "output-available",
    input: { file_path: "/repo/shot.png" },
    output: { type: "image", file: { type: "image/png" } },
  } as GramUIMessage["parts"][number],
  {
    type: "data-tool-image",
    data: { toolCallId: id, mediaType: "image/png", size: 68, path: STORED },
  },
];

afterEach(() => {
  cleanup();
  useConversationOnly.setState({ on: false });
});

describe("what Conversation only leaves out", () => {
  it("counts tool calls, reasoning and memory changes as work, and words and cards as not", () => {
    expect(isWork(bash("c1", "bun test"))).toBe(true);
    expect(isWork({ type: "reasoning", text: "hm", state: "done" })).toBe(true);
    expect(isWork({ type: "text", text: "Done." })).toBe(false);
    expect(isWork({ type: "step-start" })).toBe(false);
  });

  it("draws no row for a reply of nothing but work", () => {
    expect(
      showsInConversation(
        reply("m1", [{ type: "step-start" }, bash("c1", "bun test"), { type: "text", text: " " }]),
      ),
    ).toBe(false);
    expect(
      showsInConversation(reply("m2", [bash("c1", "bun test"), { type: "text", text: "Hi" }])),
    ).toBe(true);
    expect(showsInConversation({ id: "u", role: "user", parts: [] })).toBe(true);
  });

  it("keeps a reply whose only trace is a Markdown file it wrote", () => {
    const wrote = {
      type: "tool-Write",
      toolCallId: "w1",
      state: "output-available",
      input: { file_path: "/repo/notes.md", content: "# Notes" },
      output: "ok",
    } as GramUIMessage["parts"][number];
    expect(showsInConversation(reply("m3", [wrote]))).toBe(true);
  });
});

describe("a reply in Conversation only", () => {
  const message = reply("m1", [
    { type: "text", text: "I'll run the tests." },
    bash("c1", "bun test retry"),
    bash("c2", "git status"),
    { type: "text", text: "Both cases pass." },
  ]);

  it("shows its tool calls while the mode is off", async () => {
    render(message);
    expect(await screen.findByText("Both cases pass.")).toBeTruthy();
    expect(screen.getByTestId("tool-group")).toBeTruthy();
  });

  it("shows every word and none of the calls while it is on", async () => {
    useConversationOnly.setState({ on: true });
    render(message);
    expect(await screen.findByText("Both cases pass.")).toBeTruthy();
    expect(screen.getByText("I'll run the tests.")).toBeTruthy();
    expect(screen.queryByTestId("tool-group")).toBeNull();
    expect(screen.queryByText(/bun test retry/)).toBeNull();
  });

  it("draws nothing for a reply that was only calls", () => {
    useConversationOnly.setState({ on: true });
    render(reply("m2", [bash("c1", "bun test retry")]));
    expect(screen.queryByTestId("message-assistant")).toBeNull();
  });
});

describe("an image a tool call returned", () => {
  it("keeps a reply that is only a call with an image", () => {
    expect(showsInConversation(reply("m4", screenshot("r1")))).toBe(true);
  });

  it("stays as a thumbnail where the call was, without the call's row", async () => {
    useConversationOnly.setState({ on: true });
    const readAttachment = vi.fn(async (_thread: ThreadId, path: string) => ({
      path,
      mediaType: "image/png",
      size: 68,
      tooLarge: false,
      base64: PNG,
    }));
    render(reply("m5", [...screenshot("r1"), { type: "text", text: "A checkerboard." }]), {
      readAttachment,
    });
    const thumbnail = await screen.findByTestId("attachment-thumbnail");
    expect(readAttachment).toHaveBeenCalledWith(T, STORED);
    expect(thumbnail.getAttribute("aria-label")).toBe("Open shot.png");
    expect(screen.getByTestId("tool-images").dataset["size"]).toBe("thumbnail");
    expect(screen.queryByTestId("tool-card")).toBeNull();
  });
});

describe("the switch", () => {
  it("is a pressed button with its name while on, and the bare glyph while off", () => {
    renderPlain(<ConversationOnlyButton />);
    const button = screen.getByTestId("conversation-only");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent).toBe("");
    fireEvent.click(button);
    expect(useConversationOnly.getState().on).toBe(true);
    const pressed = screen.getByTestId("conversation-only");
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    expect(pressed.textContent).toBe("Conversation only");
  });
});

describe("the working line", () => {
  it("says how long the turn has run, and no time when its start isn't known", () => {
    renderPlain(<WorkingLine since={Date.now() - 41_000} />);
    expect(screen.getByTestId("working-line").textContent).toBe("Working41s");
    cleanup();
    renderPlain(<WorkingLine since={0} />);
    expect(screen.getByTestId("working-line").textContent).toBe("Working");
  });
});
