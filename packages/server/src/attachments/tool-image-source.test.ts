import { InvalidState, type GramUIMessage, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { canSymlink } from "../fs/test-symlinks.ts";
import { IMAGE_MAX_BYTES } from "../fs/images.ts";
import { readThreadAttachment } from "./attachments.ts";
import { captureToolImageSource } from "./tool-image-source.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const threadId = "snapshot-owner" as ThreadId;
const fixture = async (run: (dir: string, root: string) => Promise<void>, base = tmpdir()) => {
  const dir = mkdtempSync(join(base, "gram-image-source-"));
  const root = join(dir, "checkout");
  mkdirSync(root);
  try {
    await run(dir, root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("captureToolImageSource", () => {
  it("captures an exact live native read outside the checkout, including a parent alias, without granting the original path", () =>
    fixture(
      async (dir, root) => {
        const path = join(dir, "board-icon-alignment-working-after.png");
        writeFileSync(path, PNG);
        const nativeRead = { origin: "codex-image-view" as const, path, isCurrent: () => true };
        const stored = await Effect.runPromise(
          captureToolImageSource(
            join(dir, "attachments"),
            threadId,
            { toolCallId: "read", path },
            [root],
            [],
            {},
            nativeRead,
          ),
        );
        expect(stored?.data.path).toBeDefined();
        const messages: GramUIMessage[] = [
          {
            id: "reply",
            role: "assistant",
            parts: [{ type: "data-tool-image", id: stored!.id, data: stored!.data }],
          },
        ];
        expect(
          await Effect.runPromise(readThreadAttachment(messages, path).pipe(Effect.flip)),
        ).toBeInstanceOf(InvalidState);
        rmSync(path);
        expect(
          (await Effect.runPromise(readThreadAttachment(messages, stored!.data.path!))).base64,
        ).toBe(PNG.toString("base64"));
        expect(
          await Effect.runPromise(readThreadAttachment([], stored!.data.path!).pipe(Effect.flip)),
        ).toBeInstanceOf(InvalidState);
      },
      process.platform === "darwin" ? "/tmp" : tmpdir(),
    ));

  it("captures authorized bytes at read time; original deletion keeps only this thread's snapshot readable", () =>
    fixture(async (dir, root) => {
      const path = join(root, "shot.png");
      writeFileSync(path, PNG);
      const stored = await Effect.runPromise(
        captureToolImageSource(
          join(dir, "attachments"),
          threadId,
          { toolCallId: "read", path },
          [root],
          [],
        ),
      );
      expect(stored?.data.path).toBeDefined();
      expect(readFileSync(stored!.data.path!)).toEqual(PNG);
      rmSync(path);
      const messages: GramUIMessage[] = [
        {
          id: "reply",
          role: "assistant",
          parts: [{ type: "data-tool-image", id: stored!.id, data: stored!.data }],
        },
      ];
      expect(
        (
          await Effect.runPromise(
            readThreadAttachment(JSON.parse(JSON.stringify(messages)), stored!.data.path!),
          )
        ).base64,
      ).toBe(PNG.toString("base64"));
      expect(
        await Effect.runPromise(readThreadAttachment([], stored!.data.path!).pipe(Effect.flip)),
      ).toBeInstanceOf(InvalidState);
      expect(JSON.stringify(messages)).not.toContain(PNG.toString("base64"));
    }));

  it("refuses missing, unassociated, relative, unsupported, credential and mislabeled non-image sources", () =>
    fixture(async (dir, root) => {
      const outside = join(dir, "outside.png");
      const text = join(root, "text.png");
      const unsupported = join(root, "file.txt");
      const credential = join(root, ".env.png");
      for (const path of [outside, unsupported, credential]) writeFileSync(path, PNG);
      writeFileSync(text, "this is not an image");
      for (const path of [
        join(root, "missing.png"),
        outside,
        text,
        unsupported,
        credential,
        "relative.png",
        `${root}/../outside.png`,
      ]) {
        expect(
          await Effect.runPromise(
            captureToolImageSource(
              join(dir, "attachments"),
              threadId,
              { toolCallId: "read", path },
              [root],
              [],
            ),
          ),
          path,
        ).toBeUndefined();
      }
    }));

  it("captures an exact already attached external file, but no other thread's file", () =>
    fixture(async (dir, root) => {
      const path = join(dir, "attached.png");
      writeFileSync(path, PNG);
      const messages: GramUIMessage[] = [
        {
          id: "input",
          role: "user",
          parts: [{ type: "file", url: pathToFileURL(path).href, mediaType: "image/png" }],
        },
      ];
      expect(
        (
          await Effect.runPromise(
            captureToolImageSource(
              join(dir, "attachments"),
              threadId,
              { toolCallId: "read", path },
              [root],
              messages,
            ),
          )
        )?.data.path,
      ).toBeDefined();
      expect(
        await Effect.runPromise(
          captureToolImageSource(
            join(dir, "attachments"),
            "other" as ThreadId,
            { toolCallId: "read", path },
            [root],
            [],
          ),
        ),
      ).toBeUndefined();
    }));

  it("describes oversize sources without saving bytes", () =>
    fixture(async (dir, root) => {
      const path = join(root, "huge.png");
      writeFileSync(path, Buffer.alloc(IMAGE_MAX_BYTES + 1));
      const stored = await Effect.runPromise(
        captureToolImageSource(
          join(dir, "attachments"),
          threadId,
          { toolCallId: "read", path },
          [root],
          [],
        ),
      );
      expect(stored?.data).toEqual({
        toolCallId: "read",
        mediaType: "image/png",
        size: IMAGE_MAX_BYTES + 1,
      });
      expect(stored?.data.path).toBeUndefined();
    }));

  it.skipIf(process.platform === "win32")(
    "refuses a FIFO instead of blocking the event consumer",
    () =>
      fixture(async (dir, root) => {
        const path = join(root, "pipe.png");
        execFileSync("mkfifo", [path]);
        expect(
          await Effect.runPromise(
            captureToolImageSource(
              join(dir, "attachments"),
              threadId,
              { toolCallId: "read", path },
              [root],
              [],
            ),
          ),
        ).toBeUndefined();
      }),
  );

  it("refuses account stores and unassociated attachment storage even inside a broad checkout", () =>
    fixture(async (dir, root) => {
      const storage = join(dir, "attachments");
      const foreign = join(storage, "other-thread", "tool.png");
      const account = join(root, ".codex", "image.png");
      mkdirSync(join(storage, "other-thread"), { recursive: true });
      mkdirSync(join(root, ".codex"));
      for (const path of [foreign, account]) {
        writeFileSync(path, PNG);
        expect(
          await Effect.runPromise(
            captureToolImageSource(storage, threadId, { toolCallId: "read", path }, [dir], []),
          ),
        ).toBeUndefined();
      }
    }));

  it.skipIf(!canSymlink)(
    "captures an image at its canonical path inside a root opened through a link",
    () =>
      fixture(async (dir, root) => {
        const alias = join(dir, "alias");
        symlinkSync(root, alias);
        const path = join(realpathSync(root), "shot.png");
        writeFileSync(path, PNG);
        // Before, the root was chosen by spelling, so `alias` held nothing at `root`'s real path.
        const stored = await Effect.runPromise(
          captureToolImageSource(
            join(dir, "attachments"),
            threadId,
            { toolCallId: "read", path },
            [alias],
            [],
          ),
        );
        expect(stored?.data.path).toBeDefined();
        expect(readFileSync(stored!.data.path!)).toEqual(PNG);
        // A link out of the aliased root is still refused.
        writeFileSync(join(dir, "outside.png"), PNG);
        symlinkSync(join(dir, "outside.png"), join(root, "out.png"));
        expect(
          await Effect.runPromise(
            captureToolImageSource(
              join(dir, "attachments"),
              threadId,
              { toolCallId: "out", path: join(realpathSync(root), "out.png") },
              [alias],
              [],
            ),
          ),
        ).toBeUndefined();
      }),
  );

  it.skipIf(!canSymlink)(
    "refuses symlink escapes, credential links and a swap between check and open",
    () =>
      fixture(async (dir, root) => {
        const outside = join(dir, "outside.png");
        const credential = join(root, ".env.png");
        const link = join(root, "link.png");
        writeFileSync(outside, PNG);
        writeFileSync(credential, PNG);
        for (const target of [outside, credential]) {
          symlinkSync(target, link);
          expect(
            await Effect.runPromise(
              captureToolImageSource(
                join(dir, "attachments"),
                threadId,
                { toolCallId: "read", path: link },
                [root],
                [],
              ),
            ),
          ).toBeUndefined();
          rmSync(link);
        }
        const attachmentLink = join(dir, "attached-link.png");
        symlinkSync(outside, attachmentLink);
        const messages: GramUIMessage[] = [
          {
            id: "input",
            role: "user",
            parts: [
              { type: "file", url: pathToFileURL(attachmentLink).href, mediaType: "image/png" },
            ],
          },
        ];
        expect(
          await Effect.runPromise(
            captureToolImageSource(
              join(dir, "attachments"),
              threadId,
              { toolCallId: "read", path: attachmentLink },
              [root],
              messages,
            ),
          ),
        ).toBeUndefined();
        const folder = join(root, "screens");
        mkdirSync(folder);
        writeFileSync(join(folder, "shot.png"), PNG);
        mkdirSync(join(dir, "elsewhere"));
        writeFileSync(join(dir, "elsewhere", "shot.png"), PNG);
        const stored = await Effect.runPromise(
          captureToolImageSource(
            join(dir, "attachments"),
            threadId,
            { toolCallId: "read", path: join(folder, "shot.png") },
            [root],
            [],
            {
              checked: async () => {
                rmSync(folder, { recursive: true });
                symlinkSync(join(dir, "elsewhere"), folder, "dir");
              },
            },
          ),
        );
        expect(stored).toBeUndefined();
      }),
  );
});

// Regressions retained from independent exact-6855948 review; invented local files only.

it("independent source capture refuses case variants of credential folders", () =>
  fixture(async (dir, root) => {
    const leaks: string[] = [];
    for (const folder of [".AWS", ".SSH", ".config/GCloud", "Library/KEYCHAINS"]) {
      const parent = join(root, folder);
      mkdirSync(parent, { recursive: true });
      const path = join(parent, "synthetic.png");
      writeFileSync(path, PNG);
      const stored = await Effect.runPromise(
        captureToolImageSource(
          join(dir, "attachments"),
          threadId,
          { toolCallId: "read", path },
          [root],
          [],
        ),
      );
      if (stored?.data.path) leaks.push(folder);
    }
    expect(leaks).toEqual([]);
  }));
it.skipIf(process.platform === "win32")(
  "independent source capture rejects raced FIFO and unix socket without hanging",
  () =>
    fixture(async (dir, root) => {
      const path = join(root, "swap.png");
      writeFileSync(path, PNG);
      const result = await Effect.runPromise(
        captureToolImageSource(
          join(dir, "attachments"),
          threadId,
          { toolCallId: "read", path },
          [root],
          [],
          {
            checked: async () => {
              rmSync(path);
              execFileSync("mkfifo", [path]);
            },
          },
        ),
      );
      expect(result).toBeUndefined();
      rmSync(path);
      const net = await import("node:net");
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });
      try {
        expect(
          await Effect.runPromise(
            captureToolImageSource(
              join(dir, "attachments"),
              threadId,
              { toolCallId: "read", path },
              [root],
              [],
            ),
          ),
        ).toBeUndefined();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }),
);

it.skipIf(!canSymlink)(
  "independent stored snapshot cannot read a preexisting link into another thread",
  () =>
    fixture(async (dir, root) => {
      const source = join(root, "source.png");
      writeFileSync(source, PNG);
      const storage = join(dir, "attachments");
      const owner = join(storage, threadId);
      const other = join(storage, "other-thread");
      mkdirSync(owner, { recursive: true });
      mkdirSync(other, { recursive: true });
      const foreign = join(other, "foreign.png");
      const different = Buffer.concat([PNG, Buffer.from("synthetic foreign marker")]);
      writeFileSync(foreign, different);
      const crypto = await import("node:crypto");
      const hash = crypto.createHash("sha256").update(PNG).digest("hex").slice(0, 16);
      symlinkSync(foreign, join(owner, `tool-${hash}.png`));
      const stored = await Effect.runPromise(
        captureToolImageSource(storage, threadId, { toolCallId: "view", path: source }, [root], []),
      );
      expect(stored?.data.path).toBeUndefined();
      if (stored?.data.path) {
        const messages: GramUIMessage[] = [
          {
            id: "reply",
            role: "assistant",
            parts: [{ type: "data-tool-image", id: stored.id, data: stored.data }],
          },
        ];
        const image = await Effect.runPromise(readThreadAttachment(messages, stored.data.path));
        expect(image.base64).toBe(PNG.toString("base64"));
      }
    }),
);

it("independent source identity and bounds survive regular-file replacement and growth", () =>
  fixture(async (dir, root) => {
    const fs = await import("node:fs");
    const path = join(root, "grow.png");
    writeFileSync(path, PNG);
    const grown = await Effect.runPromise(
      captureToolImageSource(
        join(dir, "attachments"),
        threadId,
        { toolCallId: "grow", path },
        [root],
        [],
        { opened: async () => writeFileSync(path, Buffer.alloc(IMAGE_MAX_BYTES + 1)) },
      ),
    );
    expect(grown?.data.size).toBe(IMAGE_MAX_BYTES + 1);
    expect(grown?.data.path).toBeUndefined();
    writeFileSync(path, PNG);
    const replaced = await Effect.runPromise(
      captureToolImageSource(
        join(dir, "attachments"),
        threadId,
        { toolCallId: "swap", path },
        [root],
        [],
        {
          checked: async () => {
            fs.renameSync(path, path + ".old");
            writeFileSync(path, PNG);
          },
        },
      ),
    );
    expect(replaced).toBeUndefined();
  }));

it.skipIf(!canSymlink)(
  "refuses a real credential folder reached through an ordinary named directory",
  () =>
    fixture(async (dir, root) => {
      const credential = join(root, ".AWS");
      mkdirSync(credential);
      writeFileSync(join(credential, "invented.png"), PNG);
      const alias = join(root, "ordinary");
      symlinkSync(credential, alias, "dir");
      expect(
        await Effect.runPromise(
          captureToolImageSource(
            join(dir, "attachments"),
            threadId,
            { toolCallId: "view", path: join(alias, "invented.png") },
            [root],
            [],
          ),
        ),
      ).toBeUndefined();
    }),
);

it("cancellation after checked source open creates no snapshot association or file", () =>
  fixture(async (dir, root) => {
    const path = join(root, "cancel.png");
    writeFileSync(path, PNG);
    let reached!: () => void;
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(
          captureToolImageSource(
            join(dir, "attachments"),
            threadId,
            { toolCallId: "view", path },
            [root],
            [],
            {
              opened: async () => {
                reached();
                await gate;
              },
            },
          ),
        );
        yield* Effect.promise(() => opened);
        const stopped = yield* Effect.forkScoped(Fiber.interrupt(fiber));
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
        release();
        yield* Fiber.join(stopped);
        const exit = yield* Fiber.await(fiber);
        expect(exit._tag).toBe("Failure");
      }).pipe(Effect.scoped),
    );
    expect(existsSync(join(dir, "attachments"))).toBe(false);
  }));

it("native capability refuses mismatched, expired, credential and foreign-storage targets", () =>
  fixture(async (dir, root) => {
    const storage = join(dir, "attachments");
    const ordinary = join(dir, "ordinary.png");
    const credential = join(dir, ".AWS", "image.png");
    const account = join(dir, ".CoDeX", "image.png");
    const foreign = join(storage, "other-thread", "image.png");
    for (const path of [ordinary, credential, account, foreign]) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, PNG);
    }
    for (const [path, capabilityPath, current] of [
      [ordinary, ordinary + ".other", true],
      [ordinary, ordinary, false],
      [credential, credential, true],
      [account, account, true],
      [foreign, foreign, true],
    ] as const) {
      expect(
        await Effect.runPromise(
          captureToolImageSource(
            storage,
            threadId,
            { toolCallId: "read", path },
            [root],
            [],
            {},
            { origin: "codex-image-view", path: capabilityPath, isCurrent: () => current },
          ),
        ),
      ).toBeUndefined();
    }
  }));

it.skipIf(!canSymlink)(
  "native exact-path capture refuses final links, real protected/storage aliases and parent retargeting",
  () =>
    fixture(async (dir, root) => {
      const storage = join(dir, "attachments");
      const external = join(dir, "external");
      const protectedDir = join(dir, ".SSH");
      const foreignDir = join(storage, "other-thread");
      for (const folder of [external, protectedDir, foreignDir]) {
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "shot.png"), PNG);
      }
      const alias = join(dir, "alias");
      const read = (path: string, race = {}) =>
        Effect.runPromise(
          captureToolImageSource(
            storage,
            threadId,
            { toolCallId: "read", path },
            [root],
            [],
            race,
            { origin: "codex-image-view", path, isCurrent: () => true },
          ),
        );
      const final = join(dir, "final.png");
      symlinkSync(join(external, "shot.png"), final);
      expect(await read(final)).toBeUndefined();
      for (const folder of [protectedDir, foreignDir]) {
        symlinkSync(folder, alias, "dir");
        expect(await read(join(alias, "shot.png"))).toBeUndefined();
        rmSync(alias);
      }
      symlinkSync(external, alias, "dir");
      expect(
        await read(join(alias, "shot.png"), {
          opened: async () => {
            rmSync(alias);
            symlinkSync(protectedDir, alias, "dir");
          },
        }),
      ).toBeUndefined();
      // Keep the same file inode while replacing its parent: file-only checks cannot catch this.
      const fs = await import("node:fs");
      expect(
        await read(join(external, "shot.png"), {
          opened: async () => {
            fs.renameSync(external, external + "-old");
            mkdirSync(external);
            fs.renameSync(join(external + "-old", "shot.png"), join(external, "shot.png"));
          },
        }),
      ).toBeUndefined();
    }),
);

it("native live lane invalidation after checked open creates no snapshot", () =>
  fixture(async (dir, root) => {
    const path = join(dir, "late.png");
    writeFileSync(path, PNG);
    let current = true;
    expect(
      await Effect.runPromise(
        captureToolImageSource(
          join(dir, "attachments"),
          threadId,
          { toolCallId: "read", path },
          [root],
          [],
          {
            opened: async () => {
              current = false;
            },
          },
          { origin: "codex-image-view", path, isCurrent: () => current },
        ),
      ),
    ).toBeUndefined();
    expect(existsSync(join(dir, "attachments"))).toBe(false);
  }));
