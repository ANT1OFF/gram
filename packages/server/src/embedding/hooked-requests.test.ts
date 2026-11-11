import { describe, expect, it } from "vitest";
import { endpointFrom, ServerConfig } from "../config.ts";
import { requestActions } from "./hooked-requests.ts";

describe("requestActions", () => {
  it("asks about each outward thing a shell command does", () => {
    expect(
      requestActions({ toolName: "Bash", input: { command: "git push && gh pr create --fill" } }),
    ).toEqual([
      { action: "push", detail: { command: "git push && gh pr create --fill" } },
      { action: "pr.open", detail: { command: "git push && gh pr create --fill" } },
    ]);
  });

  it("asks about a connector's call, and not about Gram's own tools", () => {
    expect(
      requestActions({ toolName: "mcp__tracker__create_issue", input: { title: "Bug" } }),
    ).toEqual([
      {
        action: "connector.call",
        detail: {
          server: "tracker",
          tool: "create_issue",
          input: { title: "Bug" },
          toolName: "mcp__tracker__create_issue",
        },
      },
    ]);
    expect(requestActions({ toolName: "mcp__gram__set_title", input: {} })).toEqual([]);
    // A connector whose name only begins like Gram's own server is still a connector.
    expect(requestActions({ toolName: "mcp__gram__x__send", input: {} })).toMatchObject([
      { action: "connector.call", detail: { server: "gram", tool: "x__send" } },
    ]);
    expect(endpointFrom("https://example.test/x#part", undefined)).toBeUndefined();
  });

  it("leaves every other request an ordinary card", () => {
    expect(requestActions({ toolName: "Bash", input: { command: "npm test" } })).toEqual([]);
    expect(requestActions({ toolName: "Edit", input: { file_path: "a.ts" } })).toEqual([]);
    expect(requestActions({ toolName: "Bash", input: {} })).toEqual([]);
  });
});

describe("embedding endpoints in the server's config", () => {
  it("tells an endpoint that was given and can't be used from one that wasn't given", () => {
    // A mistyped hook must refuse, not turn itself off, so the two are kept apart.
    expect(
      ServerConfig.fromEnv({ GRAM_DECISION_HOOK_URL: "decisions.internal:8443/hook" }).decisionHook,
    ).toBe("unusable");
    expect(
      ServerConfig.fromEnv({
        GRAM_EVENT_SINK_URL: "https://sink.example.test/",
        GRAM_EVENT_SINK_TOKEN: "bad token",
      }).eventSink,
    ).toBe("unusable");
    expect(ServerConfig.fromEnv({ GRAM_DECISION_HOOK_URL: " " }).decisionHook).toBeUndefined();
  });

  it("are absent unless a whole http(s) URL without credentials is given", () => {
    expect(ServerConfig.fromEnv({}).decisionHook).toBeUndefined();
    expect(ServerConfig.fromEnv({}).eventSink).toBeUndefined();
    expect(endpointFrom("ftp://example.test/x", "t")).toBeUndefined();
    expect(endpointFrom("not a url", "t")).toBeUndefined();
    expect(endpointFrom("https://user:secret@example.test/x", undefined)).toBeUndefined();
    expect(endpointFrom("https://example.test/x", "a\nb")).toBeUndefined();
    expect(endpointFrom("https://example.test/x", "a b")).toBeUndefined();
    expect(
      ServerConfig.fromEnv({
        GRAM_DECISION_HOOK_URL: "https://policy.example.test/decide",
        GRAM_DECISION_HOOK_TOKEN: "abc",
        GRAM_EVENT_SINK_URL: "http://sink.internal:8080/events",
      }),
    ).toMatchObject({
      decisionHook: { url: "https://policy.example.test/decide", token: "abc" },
      eventSink: { url: "http://sink.internal:8080/events" },
    });
  });
});
