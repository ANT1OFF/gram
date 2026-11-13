import { expect, it } from "vitest";

import { nearFolder } from "./preview-file-card";

it("keeps a short folder whole and a deep one to its last part", () => {
  expect(nearFolder("/tmp/gram-report")).toBe("/tmp/gram-report");
  expect(nearFolder("/home/dev/agent-platform/docs/upgrades")).toBe("…/upgrades");
  expect(nearFolder("C:\\Users\\dev\\repo\\docs")).toBe("…/docs");
});
