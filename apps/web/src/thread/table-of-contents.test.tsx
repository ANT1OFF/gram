// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationRail, TableOfContents } from "./table-of-contents";
import { chaptersOf } from "./parts";
import type { Chapter } from "./parts";

afterEach(cleanup);

const chapters: Chapter[] = [
  { id: "c1", messageId: "u1", title: "Reproduce the flake", kind: "prompt", index: 0 },
  { id: "c2", messageId: "a2", title: "Fix the timer", kind: "chapter", index: 3 },
];

describe("TableOfContents", () => {
  it("renders nothing without chapters", () => {
    const { container } = render(<TableOfContents chapters={[]} onJump={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("jumps to a chapter from the menu and closes it", async () => {
    const onJump = vi.fn();
    render(<TableOfContents chapters={chapters} onJump={onJump} />);
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    const item = await screen.findByRole("menuitem", { name: "Fix the timer" });
    fireEvent.click(item);
    expect(onJump).toHaveBeenCalledWith("a2");
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
  });

  it("closes on Escape and gives focus back to Contents", async () => {
    render(<TableOfContents chapters={chapters} onJump={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Contents" });
    trigger.focus();
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("an open menu activates the stable message anchor after older history is prepended", async () => {
    const onJump = vi.fn();
    const messages = [
      {
        id: "decision",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Keep SQLite" }],
      },
    ];
    const view = render(<TableOfContents chapters={chaptersOf(messages)} onJump={onJump} />);
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    await screen.findByRole("menuitem", { name: "Keep SQLite" });
    view.rerender(
      <TableOfContents
        chapters={chaptersOf([
          { id: "older", role: "user", parts: [{ type: "text", text: "Consider storage" }] },
          ...messages,
        ])}
        onJump={onJump}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Keep SQLite" }));
    expect(onJump).toHaveBeenCalledWith("decision");
  });
});

describe("outline history continuity", () => {
  it("exposes earlier history even when the loaded page has no eligible anchors", async () => {
    const onLoadEarlier = vi.fn();
    render(
      <TableOfContents chapters={[]} onJump={() => {}} earlier onLoadEarlier={onLoadEarlier} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Load earlier prompts and chapters" }),
    );
    expect(onLoadEarlier).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("distinguishes loading, failed retry and complete history", async () => {
    const onLoadEarlier = vi.fn();
    const view = render(
      <TableOfContents
        chapters={chapters}
        onJump={() => {}}
        earlier
        loadingEarlier
        onLoadEarlier={onLoadEarlier}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    const loading = await screen.findByRole("menuitem", {
      name: "Loading earlier prompts and chapters…",
    });
    expect(loading.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(loading);
    expect(onLoadEarlier).not.toHaveBeenCalled();
    view.rerender(
      <TableOfContents
        chapters={chapters}
        onJump={() => {}}
        earlier
        earlierFailed
        onLoadEarlier={onLoadEarlier}
      />,
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Couldn't load earlier prompts and chapters. Try again",
      }),
    );
    expect(onLoadEarlier).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    view.rerender(
      <TableOfContents chapters={chapters} onJump={() => {}} onLoadEarlier={onLoadEarlier} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Contents" }));
    await screen.findByRole("menuitem", { name: "Fix the timer" });
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("keeps the stable anchor, order and keyboard endpoints across a same-count reorder", () => {
    const onJump = vi.fn();
    const view = render(<ConversationRail chapters={chapters} currentId="c1" onJump={onJump} />);
    const first = screen.getByRole("button", { name: "Reproduce the flake" });
    first.focus();
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fix the timer" }));
    view.rerender(
      <ConversationRail chapters={[chapters[1]!, chapters[0]!]} currentId="c1" onJump={onJump} />,
    );
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute("aria-current")).toBe("location");
    fireEvent.click(first);
    expect(onJump).toHaveBeenCalledWith("u1");
    fireEvent.keyDown(first, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fix the timer" }));
  });
});

describe("rail paging focus ownership", () => {
  const older: Chapter = {
    id: "c0",
    messageId: "u0",
    title: "Earlier decision",
    kind: "prompt",
    index: 0,
  };
  const renderRail = (loading = false, loaded = false) => (
    <div>
      <ConversationRail
        chapters={loaded ? [older, ...chapters] : chapters}
        currentId="c2"
        onJump={() => {}}
        earlier
        loadingEarlier={loading}
        onLoadEarlier={() => {}}
      />
      <textarea aria-label="Synthetic composer" />
    </div>
  );

  it("keeps keyboard continuation through the disabled button's body blur", () => {
    const view = render(renderRail());
    const load = screen.getByRole("button", { name: "Load earlier prompts and chapters" });
    load.focus();
    fireEvent.click(load);
    view.rerender(renderRail(true));
    expect(
      screen
        .getByRole("button", { name: "Loading earlier prompts and chapters…" })
        .hasAttribute("disabled"),
    ).toBe(true);
    // happy-dom refuses blur() on disabled controls; model the browser's temporary body focus.
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
    expect(document.activeElement).toBe(document.body);
    view.rerender(renderRail(false, true));
    expect(screen.getByRole("button", { name: "Earlier decision" })).toBe(document.activeElement);
  });

  it("retires continuation when the reader focuses and types outside the rail", () => {
    const view = render(renderRail());
    const load = screen.getByRole("button", { name: "Load earlier prompts and chapters" });
    load.focus();
    fireEvent.click(load);
    view.rerender(renderRail(true));
    const composer = screen.getByRole("textbox", { name: "Synthetic composer" });
    composer.focus();
    fireEvent.input(composer, { target: { value: "Continue typing" } });
    view.rerender(renderRail(false, true));
    expect(document.activeElement).toBe(composer);
  });

  it("retires continuation on external wheel input without a new focus target", () => {
    const view = render(renderRail());
    const load = screen.getByRole("button", { name: "Load earlier prompts and chapters" });
    load.focus();
    fireEvent.click(load);
    view.rerender(renderRail(true));
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
    expect(document.activeElement).toBe(document.body);
    fireEvent.wheel(screen.getByRole("textbox", { name: "Synthetic composer" }), { deltaY: 400 });
    view.rerender(renderRail(false, true));
    expect(document.activeElement).toBe(document.body);
  });
});
