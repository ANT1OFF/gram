import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { canSymlink } from "../fs/test-symlinks.ts";
import type { OpenRace } from "../fs/files.ts";
import { storeToolImage } from "./tool-images.ts";

const bytes = Buffer.from("invented bounded image bytes");
const owner = "owner" as ThreadId;
const fixture = async (run: (storage: string, dir: string, path: string) => Promise<void>) => {
  const temporary = mkdtempSync(join(tmpdir(), "gram-image-destination-"));
  const storage = join(temporary, "attachments");
  const dir = join(storage, owner);
  mkdirSync(dir, { recursive: true });
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  try {
    await run(storage, dir, join(dir, `tool-${hash}.png`));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};
const store = (storage: string, race: OpenRace = {}, thread = owner) =>
  Effect.runPromise(
    storeToolImage(
      storage,
      thread,
      {
        toolCallId: "view",
        mediaType: "image/png",
        data: bytes.toString("base64"),
      },
      1024,
      race,
    ),
  );

describe("checked tool-image destinations", () => {
  it("stores normal bytes and deduplicates only an identical regular destination", () =>
    fixture(async (storage, _dir, path) => {
      expect((await store(storage)).data.path).toBe(path);
      expect((await store(storage)).data.path).toBe(path);
      expect(readFileSync(path)).toEqual(bytes);
      writeFileSync(path, Buffer.alloc(bytes.length, 120));
      expect((await store(storage)).data.path).toBeUndefined();
      writeFileSync(path, Buffer.concat([bytes, Buffer.alloc(1024)]));
      expect((await store(storage)).data.path).toBeUndefined();
    }));

  it("refuses directories and an ID that escapes owner storage", () =>
    fixture(async (storage, _dir, path) => {
      mkdirSync(path);
      expect((await store(storage)).data.path).toBeUndefined();
      expect((await store(storage, {}, "../other" as ThreadId)).data.path).toBeUndefined();
    }));

  it.skipIf(!canSymlink)("refuses file, owner-directory and storage-directory symlinks", () =>
    fixture(async (storage, dir, path) => {
      const other = join(storage, "other");
      mkdirSync(other);
      const foreign = join(other, "foreign.png");
      writeFileSync(foreign, bytes);
      symlinkSync(foreign, path);
      expect((await store(storage)).data.path).toBeUndefined();
      rmSync(path);
      linkSync(foreign, path);
      expect((await store(storage)).data.path).toBeUndefined();
      rmSync(dir, { recursive: true });
      symlinkSync(other, dir, "dir");
      expect((await store(storage)).data.path).toBeUndefined();
      rmSync(dir);
      const alias = `${storage}-alias`;
      symlinkSync(storage, alias, "dir");
      expect((await store(alias)).data.path).toBeUndefined();
    }),
  );

  it.skipIf(!canSymlink)(
    "refuses replaced parent directories before write and during checked open",
    () =>
      fixture(async (storage, dir, path) => {
        const foreign = join(storage, "foreign");
        mkdirSync(foreign);
        writeFileSync(join(foreign, basename(path)), bytes);
        const replace = async () => {
          renameSync(dir, `${dir}-old`);
          symlinkSync(foreign, dir, "dir");
        };
        expect((await store(storage, { checked: replace })).data.path).toBeUndefined();
        rmSync(dir);
        renameSync(`${dir}-old`, dir);
        expect((await store(storage, { opened: replace })).data.path).toBeUndefined();
      }),
  );

  it.skipIf(!canSymlink)(
    "refuses a destination replaced after opening even with identical bytes",
    () =>
      fixture(async (storage, _dir, path) => {
        expect(
          (
            await store(storage, {
              opened: async () => {
                renameSync(path, `${path}-old`);
                writeFileSync(path, bytes);
              },
            })
          ).data.path,
        ).toBeUndefined();
      }),
  );
});
