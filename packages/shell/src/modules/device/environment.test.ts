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

/** The answer the redactor must give however the text is cut: every place joined, then marked. */
const reference = (secrets: ReadonlyArray<string>, text: string): string => {
  const marked = Array.from({ length: text.length }, () => false);
  for (const secret of secrets)
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1))
      for (let index = at; index < at + secret.length; index += 1) marked[index] = true;
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    if (!marked[index]) out += text[index];
    // Two places that only touch stay two marks; one that overlaps another joins it.
    else if (index === 0 || !marked[index - 1] || touching(secrets, text, index)) out += REDACTED;
  }
  return out;
};

/** Whether a marked stretch really breaks at `index`: no place found runs across it. */
const touching = (secrets: ReadonlyArray<string>, text: string, index: number): boolean => {
  for (const secret of secrets)
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1))
      if (at < index && at + secret.length > index) return false;
  // Nothing runs across, so a place must start here for the stretch to continue.
  return true;
};

const inChunks = (secrets: ReadonlyArray<string>, text: string, cuts: ReadonlyArray<number>) => {
  const redactor = makeRedactor(secrets);
  let out = "";
  let from = 0;
  for (const cut of [...cuts, text.length]) {
    out += redactor.push(text.slice(from, cut));
    from = cut;
  }
  return out + redactor.end();
};

// Put together here so the file holds nothing shaped like a real token.
const TOKEN_LIKE = `${"gh"}${"p_"}${"abcdefghijklmnopqrstuvwxyz0123456789"}`;

describe("what the code review asked to hold", () => {
  it("removes credentials by words inside a name, and by what a value looks like", () => {
    const { env, removed } = filterEnvironment({
      PGPASSWORD: "p",
      BORG_PASSPHRASE: "p",
      NPM_CONFIG__AUTHTOKEN: "t",
      "npm_config_//registry.npmjs.org/:_authToken": "t",
      ACCESSTOKEN: "t",
      SECRETKEY: "k",
      PRIVATEKEY: "k",
      SLACK_WEBHOOK_URL: "https://hooks.example.com/x",
      AZURE_STORAGE_CONNECTION_STRING: "x",
      JWT: "x",
      BEARER: "x",
      KRB5CCNAME: "FILE:/tmp/krb5cc_1000",
      GIT_SSH_COMMAND: "ssh -i ~/.ssh/deploy",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic eA==",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      ORIGIN: `https://${TOKEN_LIKE}@github.com/o/r`,
      LIBPQ: "host=db password=hunter2hunter2",
      STORAGE: "DefaultEndpointsProtocol=https;AccountKey=abcdef0123456789==",
      SOME_ID: TOKEN_LIKE,
      WHO: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2ln",
      DEPLOY: `${"-".repeat(5)}BEGIN OPENSSH PRIVATE KEY${"-".repeat(5)}\nabc`,
      MIRROR: " https://app:hunter2hunter2@mirror.example.com/",
      XDG_SESSION_ID: "3",
      TERM_SESSION_ID: "w0t0p0",
      SESSION_MANAGER: "local/host:@/tmp/.ICE-unix/1",
      HOME_PAGE: "https://example.com/a@b",
      EDITOR: "vim",
    });
    expect(Object.keys(env).toSorted()).toEqual([
      "EDITOR",
      "HOME_PAGE",
      "SESSION_MANAGER",
      "TERM_SESSION_ID",
      "XDG_SESSION_ID",
    ]);
    expect(removed).toHaveLength(24);
  });

  it("keeps a variable called __proto__ like any other", () => {
    const env = Object.fromEntries([["__proto__", "plain"]]);
    expect(Object.entries(filterEnvironment(env).env)).toEqual([["__proto__", "plain"]]);
  });

  it("redacts the password inside a URL or a connection string on its own", () => {
    const { secrets } = filterEnvironment({
      DATABASE_URL: "postgres://app:hunter2%21hunter2@db.internal/app",
      LIBPQ: "host=db password=s3cr3tvalue",
      DB_PASSWORD: "hunter2",
      FLAG_TOKEN: "true",
    });
    expect(secrets).toEqual(
      expect.arrayContaining(["hunter2%21hunter2", "hunter2!hunter2", "s3cr3tvalue", "hunter2"]),
    );
    expect(secrets).not.toContain("true");
    const redactor = makeRedactor(secrets);
    expect(
      redactor.push("psql postgres://app:hunter2%21hunter2@db.internal/other") + redactor.end(),
    ).toBe(`psql postgres://app:${REDACTED}@db.internal/other`);
  });

  it("gives the same answer however two values that start alike are cut", () => {
    const secrets = ["abcdefgh", "abcdefghIJKLMNOP"];
    const text = "-abcdefghIJKLMNOP-abcdefghIJK-";
    const whole = inChunks(secrets, text, []);
    expect(whole).toBe(`-${REDACTED}-${REDACTED}IJK-`);
    for (let cut = 1; cut < text.length; cut += 1)
      expect(inChunks(secrets, text, [cut]), `cut at ${cut}`).toBe(whole);
  });

  it("joins two values that overlap into one mark, leaving no tail of either", () => {
    const secrets = ["aaaaXXXXbbbb", "XXXXbbbbcccc"];
    const text = "aaaaXXXXbbbbcccc!";
    for (let cut = 0; cut < text.length; cut += 1)
      expect(inChunks(secrets, text, [cut]), `cut at ${cut}`).toBe(`${REDACTED}!`);
  });

  it("matches the plain answer for random values, text and cuts", () => {
    // A fixed seed: the same cases every run.
    let seed = 0x2f6e2b1;
    const random = (below: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % below;
    };
    const word = (length: number) => Array.from({ length }, () => "ab"[random(2)]).join("");
    for (let round = 0; round < 3000; round += 1) {
      const secrets = Array.from({ length: 1 + random(3) }, () => word(6 + random(4)));
      const text = word(20 + random(40));
      const cuts = Array.from({ length: random(5) }, () => random(text.length)).toSorted(
        (a, b) => a - b,
      );
      const got = inChunks(secrets, text, cuts);
      if (got !== reference(secrets, text))
        expect.fail(`${JSON.stringify({ secrets, text, cuts })} gave ${got}`);
    }
  });

  it("never holds back more than a value's length", () => {
    const redactor = makeRedactor(["ghp_0123456789abcdefghij"]);
    let out = "";
    for (let index = 0; index < 500; index += 1) {
      out += redactor.push("ghp_0123456789abcdefghi-");
      expect(out.length).toBeGreaterThanOrEqual((index + 1) * 24 - 24);
    }
  });

  it("stays quick on a long value that almost repeats", () => {
    const secret = `${"a".repeat(200_000)}b`;
    const redactor = makeRedactor([secret]);
    const started = performance.now();
    let out = redactor.push(`${"a".repeat(200_000)}c`);
    for (let index = 0; index < 50; index += 1) out += redactor.push("a".repeat(4000));
    out += redactor.push("b") + redactor.end();
    // The quadratic way took a minute and a half for the first push alone.
    expect(performance.now() - started).toBeLessThan(5000);
    expect(out.endsWith(REDACTED)).toBe(true);
  });
});
