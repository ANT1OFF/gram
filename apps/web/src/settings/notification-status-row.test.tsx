// @vitest-environment happy-dom
import type { NotificationStatus } from "@gram/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationStatusSetting, notificationStatusText } from "./notification-status-row";

const clock = () => "14:02";
const at = (outcome: "sent" | "shown" | "clicked" | "failed", test = false) =>
  notificationStatusText({ supported: true, last: { outcome, at: 0, test } }, clock);

describe("notificationStatusText", () => {
  it("says what happened to the newest notification, never that it is allowed", () => {
    expect(notificationStatusText({ supported: true, last: null }, clock)).toBe(
      "Nothing sent since Gram started",
    );
    expect(at("sent", true)).toBe("Test sent at 14:02, not confirmed yet");
    expect(at("shown", true)).toBe("Test shown at 14:02");
    expect(at("clicked")).toBe("Last one clicked at 14:02");
    expect(at("failed")).toBe("Last one refused at 14:02");
    expect(notificationStatusText({ supported: false, last: null }, clock)).toBe(
      "Not supported on this system",
    );
  });

  it("shows the time on a 24-hour clock", () => {
    const afternoon = new Date(2026, 9, 25, 14, 2).getTime();
    expect(
      notificationStatusText({
        supported: true,
        last: { outcome: "shown", at: afternoon, test: true },
      }),
    ).toBe("Test shown at 14:02");
  });
});

describe("NotificationStatusSetting", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "gram");
  });

  it("sends a test, follows what the shell reports, and shows the system's refusal", async () => {
    let notify: ((status: NotificationStatus) => void) | undefined;
    const sendTest = vi.fn(async () => {});
    const openSettings = vi.fn(async () => true);
    Object.assign(window, {
      gram: {
        platform: "darwin",
        notificationStatus: {
          get: async () => ({ supported: true, last: null }),
          onChange: (callback: (status: NotificationStatus) => void) => {
            notify = callback;
            return () => {};
          },
          sendTest,
          openSettings,
        },
      },
    });
    render(<NotificationStatusSetting />);
    expect((await screen.findByTestId("notification-status")).textContent).toBe(
      "Nothing sent since Gram started",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
    expect(sendTest).toHaveBeenCalled();
    act(() =>
      notify?.({
        supported: true,
        last: { outcome: "failed", at: 0, test: true, error: "Notifications are not allowed" },
      }),
    );
    expect(screen.getByTestId("notification-status").textContent).toMatch(/^Test refused at /);
    expect(screen.getByRole("alert").textContent).toContain("Notifications are not allowed");
    fireEvent.click(screen.getByRole("button", { name: "Open Notification settings" }));
    expect(openSettings).toHaveBeenCalled();
  });

  it("offers no settings button where the system has none to open, and nothing in a browser", async () => {
    Object.assign(window, {
      gram: {
        platform: "linux",
        notificationStatus: {
          get: async () => ({ supported: true, last: null }),
          onChange: () => () => {},
          sendTest: async () => {},
          openSettings: async () => false,
        },
      },
    });
    render(<NotificationStatusSetting />);
    await screen.findByRole("button", { name: "Send test notification" });
    expect(screen.queryByRole("button", { name: "Open Notification settings" })).toBeNull();
    cleanup();
    Reflect.deleteProperty(window, "gram");
    const { container } = render(<NotificationStatusSetting />);
    expect(container.innerHTML).toBe("");
  });
});
