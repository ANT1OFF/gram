import type { WorkspaceId } from "@gram/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { accentStyle, knownAccents, useWorkspaceAccents } from "./workspace-accent";

const id = "w-1" as WorkspaceId;

beforeEach(() => useWorkspaceAccents.setState({ byWorkspace: {} }));

describe("a workspace's colour", () => {
  it("is set, changed and taken away", () => {
    const { setAccent } = useWorkspaceAccents.getState();
    setAccent(id, "violet");
    expect(useWorkspaceAccents.getState().byWorkspace).toEqual({ "w-1": "violet" });
    setAccent(id, "teal");
    expect(useWorkspaceAccents.getState().byWorkspace).toEqual({ "w-1": "teal" });
    setAccent(id, undefined);
    expect(useWorkspaceAccents.getState().byWorkspace).toEqual({});
  });

  it("drops a stored colour no longer on offer", () => {
    expect(knownAccents({ a: "violet", b: "mauve", c: 3 })).toEqual({ a: "violet" });
    expect(knownAccents(null)).toEqual({});
    expect(knownAccents([])).toEqual({});
  });

  it("styles nothing without a colour", () => {
    expect(accentStyle(undefined)).toBeUndefined();
    expect(accentStyle("violet")).toEqual({ "--accent-hue": 295 });
  });
});
