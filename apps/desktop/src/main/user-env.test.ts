import { afterEach, describe, expect, it } from "vitest";

import { normaliseUserEnv, userEnvFixes, type Account } from "./user-env.ts";

const account: Account = { username: "alice", homedir: "/Users/alice", shell: "/bin/zsh" };
const TEMP = "/var/folders/ab/alice/T/";

describe("userEnvFixes", () => {
  it("replaces what a root LaunchDaemon's sudo -u launch hands the app: root's HOME and no TMPDIR", () => {
    const env = {
      HOME: "/var/root",
      USER: "alice",
      LOGNAME: "alice",
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SUDO_USER: "root",
    };
    expect(userEnvFixes(env, account, TEMP)).toEqual({ HOME: "/Users/alice", TMPDIR: TEMP });
  });

  it("fills in everything missing from a bare environment", () => {
    expect(userEnvFixes({ PATH: "/usr/bin:/bin" }, account, TEMP)).toEqual({
      HOME: "/Users/alice",
      USER: "alice",
      LOGNAME: "alice",
      SHELL: "/bin/zsh",
      TMPDIR: TEMP,
    });
  });

  it("takes the account's name and shell over another account's", () => {
    const env = { HOME: "/Users/alice", USER: "root", LOGNAME: "root", SHELL: "/bin/sh" };
    expect(userEnvFixes({ ...env, TMPDIR: "/tmp/" }, account, TEMP)).toEqual({
      USER: "alice",
      LOGNAME: "alice",
      SHELL: "/bin/zsh",
    });
  });

  it("changes nothing for a Dock launch, and keeps a TMPDIR the user chose", () => {
    const env = { HOME: "/Users/alice", USER: "alice", LOGNAME: "alice", SHELL: "/bin/zsh" };
    expect(userEnvFixes({ ...env, TMPDIR: "/Users/alice/tmp/" }, account, TEMP)).toEqual({});
  });

  it("leaves SHELL alone when the account has none on record", () => {
    const env = { HOME: "/Users/alice", USER: "alice", LOGNAME: "alice", TMPDIR: TEMP };
    expect(userEnvFixes(env, { ...account, shell: null }, TEMP)).toEqual({});
  });
});

describe("normaliseUserEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });

  it("sets the fixes on process.env and reports the values it replaced", () => {
    process.env["HOME"] = "/var/root";
    process.env["USER"] = "alice";
    process.env["LOGNAME"] = "alice";
    process.env["SHELL"] = "/bin/zsh";
    delete process.env["TMPDIR"];
    expect(normaliseUserEnv(TEMP, account)).toEqual({ HOME: "/var/root", TMPDIR: undefined });
    expect(process.env["HOME"]).toBe("/Users/alice");
    expect(process.env["TMPDIR"]).toBe(TEMP);
  });
});
