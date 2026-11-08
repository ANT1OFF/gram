// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { deviceSeen, QrCode } from "./phone-access-page";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-06-15T10:00:00Z");
const device = (lastSeenAt?: number) => ({
  id: "a1b2c3d4e5f60718",
  label: "iPhone · Safari",
  pairedAt: NOW - 13 * 24 * HOUR,
  ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
  expiresAt: NOW + 300 * 24 * HOUR,
});

describe("phone access page", () => {
  it("says when a browser paired and was last seen, to the hour the server keeps", () => {
    expect(deviceSeen(device(NOW - (NOW % HOUR)), NOW)).toMatch(
      /^Paired 2 Jun · last seen this hour$/,
    );
    expect(deviceSeen(device(NOW - 12 * HOUR), NOW)).toBe("Paired 2 Jun · last seen 12 hours ago");
    expect(deviceSeen(device(NOW - 40 * 24 * HOUR), NOW)).toMatch(
      /^Paired 2 Jun · last seen on 6 May /,
    );
    expect(deviceSeen(device(), NOW)).toBe("Paired 2 Jun · not seen since");
  });

  it("draws the link as a QR code with a light quiet zone in either theme", () => {
    render(<QrCode text="https://mac.tail-example.ts.net:9443/remote/connect#pair=x" label="QR" />);
    const svg = screen.getByRole("img", { name: "QR" });
    const [ground, modules] = svg.children;
    expect(ground?.getAttribute("fill")).toBe("white");
    expect(modules?.getAttribute("d")).toMatch(/^M4 4h1v1h-1z/);
  });
});
