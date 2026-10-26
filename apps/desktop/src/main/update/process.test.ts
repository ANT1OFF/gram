import { describe, expect, it } from "vitest";

import { ghEnv } from "./process.ts";

describe("ghEnv", () => {
  it("runs gh on the login-shell PATH, without prompts", () => {
    const env = ghEnv(
      { PATH: "/usr/bin:/bin", HOME: "/Users/me" },
      "/Users/me/.local/bin:/opt/tools/bin:/usr/bin:/bin",
      "darwin",
    );
    expect(env).toMatchObject({
      PATH: "/Users/me/.local/bin:/opt/tools/bin:/usr/bin:/bin",
      HOME: "/Users/me",
      GH_PROMPT_DISABLED: "1",
    });
  });

  it("keeps the inherited PATH on Windows", () => {
    const env = ghEnv({ Path: "C:\\Program Files\\GitHub CLI" }, "", "win32");
    expect(env["Path"]).toBe("C:\\Program Files\\GitHub CLI");
    expect(env).not.toHaveProperty("PATH");
    expect(env["GH_PROMPT_DISABLED"]).toBe("1");
  });
});
