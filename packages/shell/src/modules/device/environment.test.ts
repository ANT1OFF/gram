import { describe, expect, it } from "vitest";
import { filterEnvironment, makeRedactor, REDACTED } from "./environment.ts";

describe("filterEnvironment", () => {
  it("keeps what tools need and removes what reads as a credential", () => {
    const { env, removed } = filterEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/home/ada",
      PWD: "/home/ada/code",
      LANG: "en_GB.UTF-8",
      EDITOR: "vim",
      TOKENIZERS_PARALLELISM: "false",
      XDG_SESSION_TYPE: "wayland",
      KEYBOARD_LAYOUT: "no",
      MONKEY: "banana",
      GH_TOKEN: "ghp_0123456789abcdef",
      GITHUB_PAT: "github_pat_0123456789",
      NPM_TOKEN: "npm_0123456789",
      NODE_AUTH_TOKEN: "npm_abcdefghij",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG",
      AWS_SESSION_TOKEN: "FwoGZXIvYXdzE",
      OPENAI_API_KEY: "sk-0123456789abcdef",
      anthropic_api_key: "sk-ant-0123456789",
      DB_PASSWORD: "hunter2hunter2",
      SENTRY_DSN: "https://abc@sentry.example/1",
      BW_SESSION: "c2Vzc2lvbi1rZXk",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/ada/sa.json",
      DATABASE_URL: "postgres://app:hunter2@db.internal/app",
      HTTPS_PROXY: "http://ada:pw12345678@proxy.example:8080",
      UNSET: undefined,
    });
    expect(Object.keys(env).toSorted()).toEqual([
      "EDITOR",
      "HOME",
      "KEYBOARD_LAYOUT",
      "LANG",
      "MONKEY",
      "PATH",
      "PWD",
      "TOKENIZERS_PARALLELISM",
      "XDG_SESSION_TYPE",
    ]);
    expect(removed).toContain("DATABASE_URL");
    expect(removed).toContain("anthropic_api_key");
    expect(removed).not.toContain("UNSET");
  });

  it("never lends the signing agent or lets a command raise a password window", () => {
    const { env } = filterEnvironment({
      SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock",
      SSH_ASKPASS: "/usr/bin/ksshaskpass",
      SUDO_ASKPASS: "/usr/bin/ssh-askpass",
      GIT_ASKPASS: "/usr/bin/git-askpass",
      SSH_AGENT_PID: "1234",
      PATH: "/bin",
    });
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("keeps a URL without a password", () => {
    const { env } = filterEnvironment({
      REGISTRY: "https://registry.example.com/",
      GIT_REMOTE: "git@github.com:example/app.git",
    });
    expect(Object.keys(env).toSorted()).toEqual(["GIT_REMOTE", "REGISTRY"]);
  });

  it("gives the values to redact, without the ones too short to tell from ordinary text", () => {
    const { secrets } = filterEnvironment({
      GH_TOKEN: "ghp_0123456789abcdef",
      DEBUG_TOKEN: "1",
      OTHER_TOKEN: "ghp_0123456789abcdef",
    });
    expect(secrets).toEqual(["ghp_0123456789abcdef"]);
  });
});

describe("makeRedactor", () => {
  const SECRET = "ghp_0123456789abcdef";

  it("redacts a removed value from output", () => {
    const redactor = makeRedactor([SECRET]);
    expect(redactor.push(`token=${SECRET}\n`) + redactor.end()).toBe(`token=${REDACTED}\n`);
  });

  it("redacts a value cut across chunks, wherever the cut falls", () => {
    const text = `a ${SECRET} b ${SECRET}${SECRET} c`;
    const expected = `a ${REDACTED} b ${REDACTED}${REDACTED} c`;
    for (let size = 1; size <= text.length; size += 1) {
      const redactor = makeRedactor([SECRET]);
      let out = "";
      for (let at = 0; at < text.length; at += size)
        out += redactor.push(text.slice(at, at + size));
      out += redactor.end();
      expect(out, `chunks of ${size}`).toBe(expected);
    }
  });

  it("never lets part of a value out while the rest may still come", () => {
    const redactor = makeRedactor([SECRET]);
    const first = redactor.push(`x ${SECRET.slice(0, 12)}`);
    expect(first).toBe("x ");
    expect(redactor.push(SECRET.slice(12))).toBe(REDACTED);
  });

  it("lets a tail go once it can't be the start of a value, and at the end", () => {
    const redactor = makeRedactor([SECRET]);
    expect(redactor.push("ghp_0123")).toBe("");
    expect(redactor.push("xyz")).toBe("ghp_0123xyz");
    expect(redactor.push("ghp_")).toBe("");
    expect(redactor.end()).toBe("ghp_");
  });

  it("takes the longer of two values that overlap", () => {
    const redactor = makeRedactor(["abcdefgh", "abcdefghijkl"]);
    expect(redactor.push("-abcdefghijkl-") + redactor.end()).toBe(`-${REDACTED}-`);
  });

  it("passes everything through when there is nothing to redact", () => {
    const redactor = makeRedactor(["short"]);
    expect(redactor.push("short text")).toBe("short text");
    expect(redactor.end()).toBe("");
  });
});
