import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSessionHome } from "./session-home.ts";

it("resolves a home behind an alias, including a part not yet created", () => {
  // Physical, as the homes it is compared with are: macOS's temp folder is behind /var → /private/var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gram-canonical-home-")));
  try {
    const user = join(root, "user");
    mkdirSync(user);
    const alias = join(root, "alias");
    symlinkSync(user, alias, process.platform === "win32" ? "junction" : "dir");
    expect(canonicalSessionHome(join(alias, "not-yet-created"))).toBe(
      join(user, "not-yet-created"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
