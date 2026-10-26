import { describe, expect, it } from "vitest";
import { presentableUrl, redactSecrets, redactText } from "./redact.ts";

describe("redactText", () => {
  it("redacts launch tokens, bearer credentials and provider keys", () => {
    expect(redactText("boot http://127.0.0.1:4317/?boot=c4b154241fdbc8678cdca7ee")).toBe(
      "boot http://127.0.0.1:4317/?boot=[redacted]",
    );
    expect(redactText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redactText("key sk-ant-api03-abcdefghijklmnopqrstuv in env")).toBe(
      "key [redacted] in env",
    );
    expect(redactText("gh auth ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("gh auth [redacted]");
    expect(redactText("AKIAIOSFODNN7EXAMPLE")).toBe("[redacted]");
  });

  it("keeps JSON valid when redacting a token field", () => {
    const line = JSON.stringify({ msg: "login", token: "abc123", apiKey: "xyz" });
    expect(JSON.parse(redactText(line))).toEqual({
      msg: "login",
      token: "[redacted]",
      apiKey: "[redacted]",
    });
  });

  it("leaves ordinary text alone", () => {
    const text = "turn finished: 1204 tokens, 3 files changed, keybindings reloaded";
    expect(redactText(text)).toBe(text);
  });
});

describe("redactSecrets", () => {
  it("censors secret-named keys at any depth and redacts text values", () => {
    expect(
      redactSecrets({
        editor: { command: "code -g" },
        profiles: [{ name: "gateway", apiKey: "live-key", url: "https://x/?token=abc" }],
        logLevel: "info",
      }),
    ).toEqual({
      editor: { command: "code -g" },
      profiles: [{ name: "gateway", apiKey: "[redacted]", url: "https://x/?token=[redacted]" }],
      logLevel: "info",
    });
  });
});

describe("presentableUrl", () => {
  it("masks query values and drops userinfo and fragments, parsed or not", () => {
    expect(presentableUrl("https://u:pw@organization.example.invalid/x?key=abc&key=d#frag")).toBe(
      "https://organization.example.invalid/x?key=••••",
    );
    expect(presentableUrl("not a url //u:pw@host/x?token=abc#f")).toBe("not a url //host/x");
    expect(presentableUrl("//host/path@x")).toBe("//host/path@x");
    // Linear in the length of what it can't parse, where a backtracking pattern was quadratic.
    const started = performance.now();
    expect(presentableUrl(`#${"#".repeat(100_000)}`)).toBe("");
    expect(presentableUrl(`//${"a".repeat(100_000)}`)).toHaveLength(100_002);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
