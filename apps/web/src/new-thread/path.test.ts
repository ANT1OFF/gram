import { describe, expect, it } from "vitest";

import type { FolderEntry } from "@gram/contracts";

import { breadcrumbs, commonPrefix, splitForCompletion, tabCompletion, tildify } from "./path";

const entry = (name: string): FolderEntry => ({
  name,
  path: `/Users/dev/Documents/code/${name}`,
  isGitRepo: false,
});

describe("splitForCompletion", () => {
  it("separates the typed segment from its directory", () => {
    expect(splitForCompletion("~/Documents/co")).toEqual({ dir: "~/Documents/", leaf: "co" });
    expect(splitForCompletion("~/")).toEqual({ dir: "~/", leaf: "" });
    expect(splitForCompletion("api")).toEqual({ dir: "", leaf: "api" });
  });
});

describe("tabCompletion", () => {
  it("enters a single match", () => {
    expect(tabCompletion("~/Documents/co", [entry("code")])).toBe("~/Documents/code/");
  });

  it("extends to the common prefix of several matches", () => {
    expect(tabCompletion("~/c", [entry("client-app"), entry("client-tools")])).toBe("~/client-");
  });

  it("does nothing when the prefix can't grow", () => {
    expect(tabCompletion("~/c", [entry("code"), entry("claude")])).toBeUndefined();
    expect(tabCompletion("~/x", [])).toBeUndefined();
  });

  it("matches case-insensitively but keeps the folder's casing", () => {
    expect(commonPrefix(["Documents", "docs"])).toBe("Doc");
  });
});

describe("display helpers", () => {
  it("shows home as ~", () => {
    expect(tildify("/Users/dev/Documents", "/Users/dev")).toBe("~/Documents");
    expect(tildify("/Users/devops", "/Users/dev")).toBe("/Users/devops");
    expect(tildify("/tmp", undefined)).toBe("/tmp");
  });

  it("builds breadcrumbs from home or the root", () => {
    expect(breadcrumbs("/Users/dev/Documents/code", "/Users/dev")).toEqual([
      { label: "~", path: "/Users/dev" },
      { label: "Documents", path: "/Users/dev/Documents" },
      { label: "code", path: "/Users/dev/Documents/code" },
    ]);
    expect(breadcrumbs("/etc/hosts.d", "/Users/dev")).toEqual([
      { label: "/", path: "/" },
      { label: "etc", path: "/etc" },
      { label: "hosts.d", path: "/etc/hosts.d" },
    ]);
  });
});
