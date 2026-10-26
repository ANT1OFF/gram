import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { APP_ID } from "./app-id.ts";

describe("APP_ID", () => {
  it("is the appId electron-builder gives the Windows shortcut", () => {
    const config = readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8");
    expect(/^appId:\s*(\S+)\s*$/m.exec(config)?.[1]).toBe(APP_ID);
  });
});
