import { describe, expect, it } from "vitest";

import type { FolderEntry } from "@gram/contracts";

import {
  breadcrumbs,
  commonPrefix,
  folderLabel,
  folderPlace,
  messageParts,
  splitForCompletion,
  tabCompletion,
  tildify,
} from "./path";

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

describe("folderLabel", () => {
  it("names a clone folder by owner and repository, and any other folder by its name", () => {
    expect(folderLabel("/home/me/clones/github.com/acme/api+61a386c7374a4745")).toBe("acme/api");
    expect(folderLabel("/c/gitlab.com/group/sub+repo+0123456789abcdef/")).toBe("group/sub/repo");
    expect(folderLabel("/home/me/code/api")).toBe("api");
    expect(folderLabel("/home/me/code/notes+draft")).toBe("notes+draft");
  });
});

describe("folderPlace", () => {
  it("shows a clone by where it came from, and any other folder with home as ~", () => {
    expect(
      folderPlace("/data/state/profile-origins/github.com/acme/api+61a386c7374a4745", "/home/me"),
    ).toBe("github.com/acme/api");
    expect(folderPlace("/c/gitlab.com/group/sub+repo+0123456789abcdef", undefined)).toBe(
      "gitlab.com/group/sub/repo",
    );
    expect(folderPlace("/home/me/code/api", "/home/me")).toBe("~/code/api");
    expect(folderPlace("/srv/api", "/home/me")).toBe("/srv/api");
  });
});

describe("messageParts", () => {
  it("names a clone folder in a message by its repository, keeping the full path", () => {
    expect(
      messageParts(
        "/workspace/.cache/repos/github.com/acme/api+61a386c7374a4745 already holds a different origin.",
        undefined,
      ),
    ).toEqual([
      { path: "/workspace/.cache/repos/github.com/acme/api+61a386c7374a4745", label: "acme/api" },
      { text: " already holds a different origin." },
    ]);
  });

  it("shows other paths with home as ~ and leaves closing punctuation and plain text alone", () => {
    expect(messageParts("Couldn't read /home/me/code/api.", "/home/me")).toEqual([
      { text: "Couldn't read " },
      { path: "/home/me/code/api", label: "~/code/api" },
      { text: "." },
    ]);
    expect(messageParts("Pick at least one repository.", "/home/me")).toEqual([
      { text: "Pick at least one repository." },
    ]);
    expect(messageParts("owner/repo and 1/2 aren't paths", undefined)).toEqual([
      { text: "owner/repo and 1/2 aren't paths" },
    ]);
  });
});
