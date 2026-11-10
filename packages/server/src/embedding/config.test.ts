import { describe, expect, it } from "vitest";
import { ServerConfig } from "../config.ts";
import { embedFromEnv } from "./config.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("embedFromEnv", () => {
  it("configures nothing from an environment that names nothing", () => {
    expect(embedFromEnv({})).toBeUndefined();
    expect(embedFromEnv({ GRAM_REPO_EVENTS: "poll", GRAM_EMBED_TOKEN: "" })).toBeUndefined();
    expect(ServerConfig.fromEnv({})).not.toHaveProperty("embed");
  });

  it("reads the inbound token, pushed events and each outside service", () => {
    expect(
      embedFromEnv({
        GRAM_EMBED_TOKEN: TOKEN,
        GRAM_REPO_EVENTS: "pushed",
        GRAM_SCHEDULER_URL: "http://scheduler.platform.svc:8080/v1/",
        GRAM_SCHEDULER_TOKEN: `s${TOKEN}`,
        GRAM_OBJECT_STORE_URL: "https://objects.example.com/workspace-1",
      }),
    ).toEqual({
      inboundToken: TOKEN,
      repoEvents: "pushed",
      scheduler: { url: "http://scheduler.platform.svc:8080/v1", token: `s${TOKEN}` },
      objectStore: { url: "https://objects.example.com/workspace-1" },
    });
    expect(ServerConfig.fromEnv({ GRAM_EMBED_TOKEN: TOKEN }).embed).toEqual({
      inboundToken: TOKEN,
      repoEvents: "poll",
    });
  });

  it("refuses a short token, and never repeats a value in what it throws", () => {
    expect(() => embedFromEnv({ GRAM_EMBED_TOKEN: "short" })).toThrow("GRAM_EMBED_TOKEN");
    expect(() => embedFromEnv({ GRAM_EMBED_TOKEN: `${TOKEN} ${TOKEN}` })).toThrow("whitespace");
    const url = "https://user:hunter2@objects.example.com/";
    let message = "";
    try {
      embedFromEnv({ GRAM_OBJECT_STORE_URL: url });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("GRAM_OBJECT_STORE_URL");
    expect(message).not.toContain("hunter2");
  });

  it("refuses a URL that isn't a plain http(s) one", () => {
    for (const url of ["file:///etc", "objects.example.com", "https://x.example/?a=1", "ftp://x"]) {
      expect(() => embedFromEnv({ GRAM_OBJECT_STORE_URL: url })).toThrow("GRAM_OBJECT_STORE_URL");
    }
    expect(() => embedFromEnv({ GRAM_SCHEDULER_TOKEN: TOKEN })).toThrow("GRAM_SCHEDULER_URL");
  });

  it("refuses what could never work: calls back with no token to prove them", () => {
    expect(() => embedFromEnv({ GRAM_REPO_EVENTS: "pushed" })).toThrow("GRAM_EMBED_TOKEN");
    expect(() => embedFromEnv({ GRAM_SCHEDULER_URL: "http://s.svc" })).toThrow("GRAM_EMBED_TOKEN");
    expect(() => embedFromEnv({ GRAM_REPO_EVENTS: "webhook" })).toThrow("GRAM_REPO_EVENTS");
  });
});
