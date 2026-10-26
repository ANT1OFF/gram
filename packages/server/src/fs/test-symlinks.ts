import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

/**
 * Whether this process may create a symlink, for `skipIf` on tests that plant one. Windows needs
 * Developer Mode or elevation for it: CI's runner has it, a locked-down laptop gets `EPERM`.
 */
export const canSymlink = ((): boolean => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-symlink-probe-"));
  try {
    fs.symlinkSync(dir, nodePath.join(dir, "link"));
    return true;
  } catch {
    // EPERM without the privilege; the tests that plant one skip.
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
