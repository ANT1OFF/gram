// The install record on disk: one small owner-only file, read once and removed at launch.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  NATIVE_RECORD_FILE,
  NATIVE_RECORD_MAX_BYTES,
  parseInstallRecord,
  serializeInstallRecord,
  type NativeInstallRecord,
} from "@gram/shell/modules/update";

export function nativeRecordStore(dir: string) {
  const path = join(dir, NATIVE_RECORD_FILE);
  return {
    path,
    /** The record, or undefined when there's none or the file isn't exactly one. */
    async read(): Promise<NativeInstallRecord | undefined> {
      let handle;
      try {
        // Non-blocking, so a FIFO planted at the path can't hold the launch on its read.
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch {
        return undefined;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > NATIVE_RECORD_MAX_BYTES) return undefined;
        const buffer = Buffer.alloc(NATIVE_RECORD_MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > NATIVE_RECORD_MAX_BYTES) return undefined;
        return parseInstallRecord(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await handle.close();
      }
    },
    async write(record: NativeInstallRecord): Promise<void> {
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, serializeInstallRecord(record), { mode: 0o600, flag: "wx" });
        await rename(tmp, path);
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
    },
    remove: () => rm(path, { force: true }),
  };
}
