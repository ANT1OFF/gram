import { describe, expect, it } from "vitest";
import { isFolderProject, machineOfProject, machineProjectRoot } from "./hosts.ts";
import { HostId } from "./ids.ts";
import { checkoutRequestHost } from "./threads.ts";

const MACHINE = HostId.make("m-0123456789abcdef01234567");

describe("a joined machine's project", () => {
  it("is keyed by the machine, never by a folder of this machine", () => {
    const project = { root: machineProjectRoot(MACHINE) };
    expect(machineOfProject(project)).toBe(MACHINE);
    expect(isFolderProject(project)).toBe(false);
    expect(project.root.startsWith("/")).toBe(false);
  });

  it("leaves every folder project alone", () => {
    for (const root of ["/Users/dev/code/api", "C:\\code\\api", "gram-host:"])
      expect(machineOfProject({ root }), root).toBeUndefined();
  });
});

describe("checkoutRequestHost", () => {
  it("is the machine a request names, and this one otherwise", () => {
    expect(checkoutRequestHost({ kind: "machineFolder", hostId: MACHINE, path: "~" })).toBe(
      MACHINE,
    );
    expect(checkoutRequestHost({ kind: "newWorktree", branch: "b", hostId: MACHINE })).toBe(
      MACHINE,
    );
    expect(checkoutRequestHost({ kind: "newWorktree", branch: "b" })).toBeUndefined();
    expect(checkoutRequestHost({ kind: "current" })).toBeUndefined();
  });
});
