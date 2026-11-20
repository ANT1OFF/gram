import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  type Workspace,
  Workspace as WorkspaceSchema,
  withWorkspaceEnvironment,
} from "./workspaces.ts";

// A workspace's environment as a save leaves it: a settings save that names none (a rename, a
// repository added) must never drop the one the person picked.

const workspace = Schema.decodeUnknownSync(WorkspaceSchema)({
  id: "11111111-1111-4111-8111-111111111111",
  name: "api",
  projectIds: ["p1"],
  homeProjectId: "p1",
  createdAt: 1,
  environment: "env-node",
}) satisfies Workspace;

describe("a workspace's environment", () => {
  it("is kept by a save that names none, changed by one that does, and dropped by null", () => {
    expect(withWorkspaceEnvironment(workspace, undefined).environment).toBe("env-node");
    expect(withWorkspaceEnvironment(workspace, "env-bun").environment).toBe("env-bun");
    expect("environment" in withWorkspaceEnvironment(workspace, null)).toBe(false);
  });

  it("is an id, never text with spaces or a path", () => {
    const decode = Schema.decodeUnknownExit(WorkspaceSchema);
    expect(decode({ ...workspace, environment: "../etc" })._tag).toBe("Failure");
    expect(decode({ ...workspace, environment: "two words" })._tag).toBe("Failure");
    expect(decode({ ...workspace, environment: "0b5c6a1e-2f3d-4c5b-9a8e-7d6c5b4a3f21" })._tag).toBe(
      "Success",
    );
  });
});
