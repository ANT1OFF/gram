import { describe, expect, it } from "vitest";

import { CHAT_MIN_WIDTH } from "@/stores/layout";

import { inboxDockFit, type InboxDockInput } from "./inbox-dock";
import { INBOX_DOCK_WIDTH } from "./inbox-store";

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
    expect(fit).toMatchObject({ sidebar: "full", sidebarWidth: 248, width: 720 });
    expect(1728 - 248 - fit!.width).toBeGreaterThan(CHAT_MIN_WIDTH);
  });

  it("narrows to leave the chat its minimum", () => {
    const fit = inboxDockFit(window(1280), 900);
    expect(fit?.width).toBe(1280 - 248 - CHAT_MIN_WIDTH);
    expect(fit?.bounds.max).toBe(1280 - 248 - CHAT_MIN_WIDTH);
  });

  it("is a dialog where the list and detail don't fit beside the chat", () => {
    expect(inboxDockFit(window(1100), INBOX_DOCK_WIDTH.default)).toBeUndefined();
  });

  it("takes the room a hidden overview leaves", () => {
    const fit = inboxDockFit(window(1100, { focusMode: true }), INBOX_DOCK_WIDTH.default);
    expect(fit).toMatchObject({ sidebar: "none", sidebarWidth: 0, width: 720 });
  });

  it("keeps a dragged width inside its bounds", () => {
    expect(inboxDockFit(window(1728), 100)?.width).toBe(INBOX_DOCK_WIDTH.min);
  });
});
