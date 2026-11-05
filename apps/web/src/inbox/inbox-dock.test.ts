import { describe, expect, it } from "vitest";

import { CHAT_MIN_WIDTH } from "@/stores/layout";

import { inboxDockFit, type InboxDockInput } from "./inbox-dock";
import { INBOX_CHAT_MIN_WIDTH, INBOX_DOCK_AUTO_MAX, INBOX_DOCK_WIDTH } from "./inbox-store";

const window = (windowWidth: number, more: Partial<InboxDockInput> = {}): InboxDockInput => ({
  windowWidth,
  focusMode: false,
  sidebarWidth: 248,
  sidebarPeek: false,
  overviewSidebar: "open",
  ...more,
});

describe("inboxDockFit", () => {
  it("docks at its width beside the overview and the chat in a wide window", () => {
    const fit = inboxDockFit(window(1728), INBOX_DOCK_WIDTH.default);
    expect(fit).toMatchObject({ sidebar: "full", sidebarWidth: 248, width: 600 });
    expect(1728 - 248 - fit!.width).toBeGreaterThan(INBOX_CHAT_MIN_WIDTH);
  });

  it("not dragged, takes the room past the chat's reading column, up to its own", () => {
    // 1728 - 248 - 760: the chat keeps a comfortable column, the Inbox the rest.
    expect(inboxDockFit(window(1728), undefined)?.width).toBe(720);
    expect(inboxDockFit(window(2560), undefined)?.width).toBe(INBOX_DOCK_AUTO_MAX);
    // Short of that, its minimum, as before.
    expect(inboxDockFit(window(1440), undefined)?.width).toBe(INBOX_DOCK_WIDTH.min);
  });

  it("stops a drag where the transcript beside it is still readable", () => {
    const fit = inboxDockFit(window(1728), 1400);
    expect(fit?.width).toBe(1728 - 248 - INBOX_CHAT_MIN_WIDTH);
    expect(fit?.bounds.max).toBe(1728 - 248 - INBOX_CHAT_MIN_WIDTH);
  });

  it("still docks at its minimum where the window is short of that, the chat at its own", () => {
    const fit = inboxDockFit(window(1240), 900);
    expect(fit?.width).toBe(INBOX_DOCK_WIDTH.min);
    expect(1240 - 248 - fit!.width).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
  });

  it("is a dialog where the list and detail don't fit beside the chat", () => {
    expect(inboxDockFit(window(1100), INBOX_DOCK_WIDTH.default)).toBeUndefined();
  });

  it("takes the room a hidden overview leaves", () => {
    const fit = inboxDockFit(window(1100, { focusMode: true }), INBOX_DOCK_WIDTH.default);
    expect(fit).toMatchObject({ sidebar: "none", sidebarWidth: 0, width: INBOX_DOCK_WIDTH.min });
  });

  it("keeps a dragged width inside its bounds", () => {
    expect(inboxDockFit(window(1728), 100)?.width).toBe(INBOX_DOCK_WIDTH.min);
  });
});
