import { describe, expect, it } from "vitest";

import {
  bootUrlFromLine,
  bootUrlFromMessage,
  devAllowedOrigins,
  devBootUrl,
  isBootLine,
  logLevelFromMessage,
} from "./boot.ts";

const URL_WITH_TOKEN = "http://127.0.0.1:51041/?boot=c4b154241fdbc8678cdca7eeaa9f1c5e";

describe("logLevelFromMessage", () => {
  it("takes a known level from a logLevel message and ignores anything else", () => {
    expect(logLevelFromMessage({ type: "logLevel", level: "debug" })).toBe("debug");
    for (const message of [
      null,
      { type: "logLevel", level: "verbose" },
      { type: "logLevel" },
      { type: "boot", level: "info" },
    ]) {
      expect(logLevelFromMessage(message)).toBeNull();
    }
  });
});

describe("bootUrlFromMessage", () => {
  it("takes the URL from a boot message", () => {
    expect(bootUrlFromMessage({ type: "boot", url: URL_WITH_TOKEN })).toBe(URL_WITH_TOKEN);
    expect(bootUrlFromMessage({ type: "boot", url: "http://localhost:8080/?boot=abc" })).toBe(
      "http://localhost:8080/?boot=abc",
    );
  });

  it("ignores other messages and URLs that aren't a loopback launch URL", () => {
    for (const message of [
      null,
      "boot",
      { type: "ready", url: URL_WITH_TOKEN },
      { type: "boot" },
      { type: "boot", url: 42 },
      { type: "boot", url: "http://127.0.0.1:51041/" },
      { type: "boot", url: "http://127.0.0.1:51041/?boot=" },
      { type: "boot", url: "http://evil.example/?boot=abc" },
      { type: "boot", url: "file:///etc/passwd?boot=abc" },
      { type: "boot", url: "not a url" },
    ]) {
      expect(bootUrlFromMessage(message), JSON.stringify(message)).toBeNull();
    }
  });
});

describe("bootUrlFromLine", () => {
  it("takes a tokenised URL from a headless boot line", () => {
    expect(bootUrlFromLine(`boot ${URL_WITH_TOKEN}`)).toBe(URL_WITH_TOKEN);
    expect(bootUrlFromLine(`boot ${URL_WITH_TOKEN}  `)).toBe(URL_WITH_TOKEN);
  });

  it("rejects the tokenless line the server prints under utilityProcess", () => {
    expect(isBootLine("boot http://127.0.0.1:51041/")).toBe(true);
    expect(bootUrlFromLine("boot http://127.0.0.1:51041/")).toBeNull();
  });

  it("ignores ordinary log lines", () => {
    expect(isBootLine("listening on 127.0.0.1")).toBe(false);
    expect(bootUrlFromLine("migrations applied")).toBeNull();
  });
});

describe("dev boot flow", () => {
  it("moves the launch token onto the Vite origin", () => {
    expect(devBootUrl(URL_WITH_TOKEN, "http://localhost:5173")).toBe(
      "http://localhost:5173/?boot=c4b154241fdbc8678cdca7eeaa9f1c5e",
    );
    expect(devBootUrl("http://127.0.0.1:4317/?boot=abc", "http://localhost:5173/app")).toBe(
      "http://localhost:5173/?boot=abc",
    );
  });

  it("allows the Vite origin under both loopback host names", () => {
    expect(devAllowedOrigins("http://localhost:5173")).toBe(
      "http://localhost:5173,http://127.0.0.1:5173",
    );
    expect(devAllowedOrigins("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173");
  });
});
