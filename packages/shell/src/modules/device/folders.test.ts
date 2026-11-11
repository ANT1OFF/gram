import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_LIST_MAX_ENTRIES, DEVICE_READ_MAX_BYTES } from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  betweenCheckAndOpen,
  checkLendable,
  type LendBounds,
  type LentFolder,
  listLentFolder,
  readLentFile,
  resolveLentFile,
  resolveWorkingFolder,
} from "./folders.ts";

let base: string;
let home: string;
let bounds: LendBounds;

const write = async (path: string, text = "x") => {
  await fs.mkdir(join(path, ".."), { recursive: true });
  await fs.writeFile(path, text);
};

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "gram-device-")));
  home = join(base, "home", "ada");
  await fs.mkdir(join(home, "code", "app", "src"), { recursive: true });
  await fs.mkdir(join(home, ".ssh"), { recursive: true });
  await fs.mkdir(join(home, ".config", "gh"), { recursive: true });
  await fs.mkdir(join(home, "Library", "Gram"), { recursive: true });
  await fs.mkdir(join(home, "agents", "claude"), { recursive: true });
  bounds = {
    home,
    ownFolders: [join(home, "Library", "Gram")],
    agentHomes: [join(home, "agents", "claude")],
  };
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const lend = async (path: string): Promise<LentFolder> => {
  const checked = await checkLendable(path, bounds);
  if (!checked.ok) throw new Error(checked.why);
  return { path: checked.path, device: checked.device, inode: checked.inode, bounds };
};

describe("checkLendable", () => {
  it("lends a project folder, by where it really is", async () => {
    await fs.symlink(join(home, "code", "app"), join(home, "app-link"));
    const checked = await checkLendable(join(home, "app-link"), bounds);
    expect(checked).toMatchObject({ ok: true, path: join(home, "code", "app") });
  });

  it("refuses the disk, the home folder and anything above it", async () => {
    for (const path of ["/", home, join(base, "home"), base])
      expect(await checkLendable(path, bounds), path).toMatchObject({ ok: false });
  });

  it("refuses credential folders, agent logins and Gram's own folders, and what is in them", async () => {
    await fs.mkdir(join(home, ".ssh", "keys"), { recursive: true });
    await fs.mkdir(join(home, "Library", "Gram", "logs"), { recursive: true });
    for (const path of [
      join(home, ".ssh"),
      join(home, ".ssh", "keys"),
      join(home, ".config", "gh"),
      join(home, "Library", "Gram"),
      join(home, "Library", "Gram", "logs"),
      join(home, "agents", "claude"),
    ])
      expect(await checkLendable(path, bounds), path).toMatchObject({ ok: false });
  });

  it("refuses a folder that contains one of those", async () => {
    for (const path of [join(home, ".config"), join(home, "Library"), join(home, "agents")])
      expect(await checkLendable(path, bounds), path).toMatchObject({ ok: false });
  });

  it("refuses a link to a credential folder, whatever it is called", async () => {
    await fs.symlink(join(home, ".ssh"), join(home, "code", "notes"));
    expect(await checkLendable(join(home, "code", "notes"), bounds)).toMatchObject({ ok: false });
  });

  it("refuses a file, a missing folder and a relative path", async () => {
    await write(join(home, "code", "file.txt"));
    for (const path of [join(home, "code", "file.txt"), join(home, "nope"), "code/app"])
      expect(await checkLendable(path, bounds), path).toMatchObject({ ok: false });
  });
});

describe("readLentFile", () => {
  it("reads a file inside the folder, bounded", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(folder.path, "src", "main.ts"), "0123456789");
    const whole = await readLentFile(folder, "src/main.ts", 100);
    expect(whole).toMatchObject({ ok: true, truncated: false });
    expect(whole.ok && whole.data.toString()).toBe("0123456789");
    const part = await readLentFile(folder, "src/main.ts", 4);
    expect(part.ok && part.data.toString()).toBe("0123");
    expect(part).toMatchObject({ truncated: true });
    const exact = await readLentFile(folder, "./src//main.ts", 10);
    expect(exact).toMatchObject({ ok: true, truncated: false });
  });

  it("refuses a path that is absolute, climbs out or has a NUL", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(home, "code", "other.txt"));
    for (const path of ["/etc/hosts", "../other.txt", "src/../../other.txt", "src/\0main.ts"])
      expect(await readLentFile(folder, path, 100), path).toEqual({
        ok: false,
        why: "outside-folders",
      });
  });

  it("refuses a link that leaves the folder, at any depth", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(home, "secret.txt"), "s3cret");
    await fs.symlink(join(home, "secret.txt"), join(folder.path, "notes.txt"));
    await fs.symlink(home, join(folder.path, "up"));
    expect(await readLentFile(folder, "notes.txt", 100)).toEqual({
      ok: false,
      why: "outside-folders",
    });
    expect(await readLentFile(folder, "up/secret.txt", 100)).toEqual({
      ok: false,
      why: "outside-folders",
    });
  });

  it("follows a link that stays inside the folder", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(folder.path, "src", "main.ts"), "inside");
    await fs.symlink(join(folder.path, "src", "main.ts"), join(folder.path, "entry.ts"));
    const read = await readLentFile(folder, "entry.ts", 100);
    expect(read.ok && read.data.toString()).toBe("inside");
    expect(read).toMatchObject({ path: join(folder.path, "src", "main.ts") });
  });

  it("refuses .git and credential names, in any case and behind a link", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(folder.path, ".git", "config"), "[remote]\nurl = https://x:tok@h/r");
    await write(join(folder.path, ".env.production"), "KEY=1");
    await write(join(folder.path, "deploy", "id_ed25519"), "key");
    await write(join(folder.path, "certs", "server.pem"), "pem");
    await write(join(folder.path, ".npmrc"), "//r/:_authToken=x");
    await fs.symlink(join(folder.path, ".env.production"), join(folder.path, "settings.txt"));
    await fs.symlink(join(folder.path, ".git"), join(folder.path, "meta"));
    for (const path of [
      ".git/config",
      ".env.production",
      "deploy/id_ed25519",
      "certs/server.pem",
      ".npmrc",
      "settings.txt",
      "meta/config",
    ])
      expect(await readLentFile(folder, path, 100), path).toEqual({
        ok: false,
        why: "credential-path",
      });
  });

  it("refuses a folder, a missing file, a FIFO and a hard-linked file without blocking", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(home, "secret.txt"), "s3cret");
    await fs.link(join(home, "secret.txt"), join(folder.path, "alias.txt"));
    execFileSync("mkfifo", [join(folder.path, "pipe")]);
    for (const path of ["src", "nope.txt", "pipe", "alias.txt"])
      expect(await readLentFile(folder, path, 100), path).toEqual({ ok: false, why: "not-a-file" });
    expect(await resolveLentFile(folder, "alias.txt")).toEqual({ ok: false, why: "not-a-file" });
  });

  it("refuses when the file now resolves somewhere other than the ask showed", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(folder.path, "a.txt"), "a");
    await write(join(folder.path, "b.txt"), "b");
    await fs.symlink(join(folder.path, "a.txt"), join(folder.path, "current"));
    const shown = await resolveLentFile(folder, "current");
    expect(shown).toMatchObject({ ok: true, path: join(folder.path, "a.txt"), size: 1 });
    await fs.rm(join(folder.path, "current"));
    await fs.symlink(join(folder.path, "b.txt"), join(folder.path, "current"));
    expect(await readLentFile(folder, "current", 100, shown.ok ? shown.path : "")).toEqual({
      ok: false,
      why: "outside-folders",
    });
  });

  it("refuses everything once the lent folder itself was swapped for a link", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(home, "elsewhere", "main.ts"), "elsewhere");
    await fs.rename(folder.path, join(home, "code", "app-old"));
    await fs.symlink(join(home, "elsewhere"), folder.path);
    expect(await readLentFile(folder, "main.ts", 100)).toEqual({
      ok: false,
      why: "outside-folders",
    });
  });

  it("refuses a file on another disk than the folder's", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(folder.path, "a.txt"), "a");
    expect(await readLentFile({ ...folder, device: folder.device + 1 }, "a.txt", 100)).toEqual({
      ok: false,
      why: "outside-folders",
    });
  });
});

describe("listLentFolder", () => {
  it("lists names, kinds and sizes, without .git or credentials, and without following links", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(folder.path, "README.md"), "hello");
    await write(join(folder.path, ".git", "HEAD"));
    await write(join(folder.path, ".env"));
    await write(join(folder.path, "server.key"));
    await fs.symlink(home, join(folder.path, "up"));
    expect(await listLentFolder(folder, "", 100)).toEqual({
      ok: true,
      path: folder.path,
      truncated: false,
      entries: [
        { name: "README.md", kind: "file", size: 5 },
        { name: "src", kind: "folder" },
        { name: "up", kind: "other" },
      ],
    });
  });

  it("stops at its limit and says there was more", async () => {
    const folder = await lend(join(home, "code", "app"));
    for (const name of ["a", "b", "c", "d"]) await write(join(folder.path, "many", name));
    const listed = await listLentFolder(folder, "many", 3);
    expect(listed.ok && listed.entries).toHaveLength(3);
    expect(listed).toMatchObject({ truncated: true });
  });

  it("refuses to list outside the folder, into .git or through a link out", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(folder.path, ".git", "HEAD"));
    await fs.symlink(home, join(folder.path, "up"));
    expect(await listLentFolder(folder, "..", 10)).toEqual({ ok: false, why: "outside-folders" });
    expect(await listLentFolder(folder, "up", 10)).toEqual({ ok: false, why: "outside-folders" });
    expect(await listLentFolder(folder, ".git", 10)).toEqual({ ok: false, why: "credential-path" });
  });
});

describe("resolveWorkingFolder", () => {
  it("is the lent folder or a folder inside it, never a file or a way out", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(folder.path, "src", "main.ts"));
    await fs.symlink(home, join(folder.path, "up"));
    expect(await resolveWorkingFolder(folder, undefined)).toEqual({ ok: true, path: folder.path });
    expect(await resolveWorkingFolder(folder, "src")).toEqual({
      ok: true,
      path: join(folder.path, "src"),
    });
    for (const path of ["src/main.ts", "up", "..", "/tmp"])
      expect(await resolveWorkingFolder(folder, path), path).toEqual({
        ok: false,
        why: "outside-folders",
      });
  });
});

describe("what the code review asked to hold", () => {
  it("answers the same whether or not something is there, for a way out or a credential", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(home, "Documents", "tax-2025.pdf"));
    await write(join(folder.path, ".git", "refs", "heads", "release-acquisition"));
    await fs.symlink(home, join(folder.path, "up"));
    await fs.symlink(join(home, "nowhere"), join(folder.path, "dangling"));
    for (const [there, missing] of [
      ["up/Documents/tax-2025.pdf", "up/Documents/tax-2024.pdf"],
      ["up/.ssh", "up/.gnupg"],
      ["up/Documents/tax-2025.pdf/x", "up/nope/x"],
      ["up", "dangling"],
      [".git/refs/heads/release-acquisition", ".git/refs/heads/nope"],
      [".env", ".env.nope"],
    ] as const) {
      const one = await readLentFile(folder, there, 10);
      expect(one.ok, there).toBe(false);
      expect(await readLentFile(folder, missing, 10), missing).toEqual(one);
      expect(await listLentFolder(folder, missing, 10), missing).toEqual(
        await listLentFolder(folder, there, 10),
      );
    }
  });

  it("judges names before the disk: Git and credentials are refused though nothing is there", async () => {
    const folder = await lend(join(home, "code", "app"));
    for (const path of [
      "nope/.git/config",
      "x/.GIT/y",
      "repo.git/config",
      "nope/.env/data",
      "nope/id_rsa.bak",
      "nope/prod.env",
      "nope/kubeconfig",
      "nope/terraform.tfstate",
      "nope/service-account.json",
      "nope/AuthKey_ABC.p8",
      "my.key/readme.txt",
      ".ssh/config",
    ])
      expect(await readLentFile(folder, path, 10), path).toEqual({
        ok: false,
        why: "credential-path",
      });
  });

  it("refuses a name that starts with two dots, which is how a file's other forks are spelled", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(folder.path, "a.txt"));
    for (const path of ["a.txt/..namedfork/data", "..x/a.txt", "src/..."])
      expect(await readLentFile(folder, path, 10), path).toEqual({
        ok: false,
        why: "outside-folders",
      });
  });

  it("never lends a Git folder, a bare repository or a folder inside one", async () => {
    const app = join(home, "code", "app");
    await write(join(app, ".git", "config"), "url = https://x:tok@h/r");
    await write(join(app, ".git", "modules", "lib", "config"));
    await write(join(home, "code", "bare.git", "config"));
    for (const name of ["HEAD", "objects/x", "refs/x", "config"])
      await write(join(home, "code", "separate", name));
    for (const path of [
      join(app, ".git"),
      join(app, ".git", "modules", "lib"),
      join(home, "code", "bare.git"),
      join(home, "code", "separate"),
    ])
      expect(await checkLendable(path, bounds), path).toMatchObject({ ok: false });
    const folder = await lend(join(home, "code"));
    expect(await readLentFile(folder, "separate/config", 100)).toEqual({
      ok: false,
      why: "credential-path",
    });
    expect(await resolveWorkingFolder(folder, "separate")).toEqual({
      ok: false,
      why: "credential-path",
    });
    const listed = await listLentFolder(folder, "", 100);
    expect(listed.ok && listed.entries.map((entry) => entry.name)).toEqual(["app", "separate"]);
  });

  it("never lends a system folder or one that holds one", async () => {
    for (const path of [
      "/etc",
      "/usr",
      "/usr/lib",
      "/dev",
      "/var",
      "/proc",
      "/proc/self",
      "/sys",
    ]) {
      const there = await fs.stat(path).then(
        () => true,
        () => false,
      );
      if (there) expect(await checkLendable(path, bounds), path).toMatchObject({ ok: false });
    }
  });

  it("lends a folder whose own name reads like a credential, and reads inside it", async () => {
    for (const name of ["credentials", "my.key", "secrets.json", "id_rsa"]) {
      await write(join(home, "code", name, "sub", "a.txt"), "plain");
      const folder = await lend(join(home, "code", name));
      expect(await resolveWorkingFolder(folder, undefined), name).toEqual({
        ok: true,
        path: folder.path,
      });
      const read = await readLentFile(folder, "sub/a.txt", 10);
      expect(read.ok && read.data.toString(), name).toBe("plain");
      expect(await listLentFolder(folder, "", 10), name).toMatchObject({ ok: true });
    }
  });

  it("refuses a folder that became one Gram never lends after it was lent", async () => {
    const folder = await lend(join(home, "code"));
    const late = join(home, "code", "gram-data");
    const lateBounds = { ...bounds, ownFolders: [...bounds.ownFolders, late] };
    const lent = { ...folder, bounds: lateBounds };
    await write(join(late, "lending.json"), "{}");
    expect(await readLentFile(lent, "gram-data/lending.json", 10)).toEqual({
      ok: false,
      why: "credential-path",
    });
    expect(await listLentFolder(lent, "gram-data", 10)).toEqual({
      ok: false,
      why: "credential-path",
    });
  });

  it("refuses when a folder it never lends can't be compared", async () => {
    await write(join(home, "blocker"));
    const cannot = { ...bounds, ownFolders: [join(home, "blocker", "inside")] };
    expect(await checkLendable(join(home, "code", "app"), cannot)).toMatchObject({ ok: false });
    const folder = await lend(join(home, "code", "app"));
    await write(join(folder.path, "a.txt"));
    expect(await readLentFile({ ...folder, bounds: cannot }, "a.txt", 10)).toMatchObject({
      ok: false,
    });
  });

  it("refuses everything once another folder was moved into the lent folder's place", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(home, "code", "other", "main.ts"), "other project");
    await fs.rename(folder.path, join(home, "code", "app-old"));
    await fs.rename(join(home, "code", "other"), folder.path);
    expect(await readLentFile(folder, "main.ts", 100)).toEqual({
      ok: false,
      why: "outside-folders",
    });
    expect(await listLentFolder(folder, "", 100)).toEqual({ ok: false, why: "outside-folders" });
    expect(await resolveWorkingFolder(folder, undefined)).toEqual({
      ok: false,
      why: "outside-folders",
    });
  });

  it("refuses a limit that isn't a number, and never gives more than its own most", async () => {
    const folder = await lend(join(home, "code", "app"));
    await fs.writeFile(join(folder.path, "big.bin"), Buffer.alloc(DEVICE_READ_MAX_BYTES + 10, 1));
    for (let index = 0; index < DEVICE_LIST_MAX_ENTRIES + 5; index += 1)
      await fs.writeFile(join(folder.path, "src", `f${String(index).padStart(4, "0")}`), "");
    expect(await readLentFile(folder, "big.bin", Number.NaN)).toMatchObject({ ok: false });
    expect(await listLentFolder(folder, "src", Number.NaN)).toMatchObject({ ok: false });
    const read = await readLentFile(folder, "big.bin", Number.POSITIVE_INFINITY);
    expect(read).toMatchObject({ ok: false });
    const most = await readLentFile(folder, "big.bin", DEVICE_READ_MAX_BYTES * 4);
    expect(most.ok && most.data.length).toBe(DEVICE_READ_MAX_BYTES);
    expect(most).toMatchObject({ truncated: true });
    const listed = await listLentFolder(folder, "src", 100_000);
    expect(listed.ok && listed.entries).toHaveLength(DEVICE_LIST_MAX_ENTRIES);
    expect(listed).toMatchObject({ truncated: true });
    // Sorted before it is cut: the same first names each time.
    const few = await listLentFolder(folder, "src", 3);
    expect(few.ok && few.entries.map((entry) => entry.name)).toEqual(["f0000", "f0001", "f0002"]);
  });

  it("gives no size for a hard-linked file and reports special files without opening them", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(home, "secret.txt"), "s3cret");
    await fs.link(join(home, "secret.txt"), join(folder.path, "alias.txt"));
    execFileSync("mkfifo", [join(folder.path, "pipe")]);
    const listed = await listLentFolder(folder, "", 10);
    expect(listed.ok && listed.entries).toEqual([
      { name: "alias.txt", kind: "file" },
      { name: "pipe", kind: "other" },
      { name: "src", kind: "folder" },
    ]);
  });

  it("lists nothing outside when the ask showed another folder", async () => {
    const folder = await lend(join(home, "code", "app"));
    await fs.mkdir(join(folder.path, "other"));
    expect(await listLentFolder(folder, "src", 10, join(folder.path, "other"))).toEqual({
      ok: false,
      why: "outside-folders",
    });
  });

  // The kernel is asked where the handle is, which only Linux answers.
  it.runIf(process.platform === "linux")(
    "never reads or lists outside the folder while a folder on the way is swapped for a link",
    async () => {
      const folder = await lend(join(home, "code", "app"));
      const outside = join(home, "private");
      await write(join(outside, "notes.txt"), "OUTSIDE-SECRET");
      await write(join(outside, "only-outside.txt"));
      await write(join(folder.path, "d", "notes.txt"), "inside");
      const swapper = spawn(
        process.execPath,
        [
          "-e",
          `const fs = require("node:fs");
           const [at, outside] = process.argv.slice(1);
           for (;;) {
             try { fs.renameSync(at, at + ".kept"); fs.symlinkSync(outside, at); } catch {}
             try { fs.unlinkSync(at); fs.renameSync(at + ".kept", at); } catch {}
           }`,
          join(folder.path, "d"),
          outside,
        ],
        { stdio: "ignore" },
      );
      try {
        let inside = 0;
        for (let attempt = 0; attempt < 4000; attempt += 1) {
          const read = await readLentFile(folder, "d/notes.txt", 100);
          if (read.ok) {
            inside += 1;
            if (read.data.toString() !== "inside") expect.fail(`read outside at ${attempt}`);
          }
          if (attempt % 4 !== 0) continue;
          const listed = await listLentFolder(folder, "d", 100);
          if (listed.ok && listed.entries.some((entry) => entry.name === "only-outside.txt"))
            expect.fail(`listed outside at ${attempt}`);
        }
        // The swap must have been seen both ways for the test to mean anything.
        expect(inside).toBeGreaterThan(0);
        expect(inside).toBeLessThan(4000);
      } finally {
        swapper.kill("SIGKILL");
      }
    },
    60_000,
  );
});

describe("a swap that lands between the check and the open", () => {
  afterEach(() => {
    betweenCheckAndOpen.run = undefined;
  });

  it("is refused every time, for a read and for a listing", async () => {
    const folder = await lend(join(home, "code", "app"));
    const outside = join(home, "private");
    await write(join(outside, "notes.txt"), "OUTSIDE-SECRET");
    await write(join(folder.path, "d", "notes.txt"), "inside");
    betweenCheckAndOpen.run = async () => {
      await fs.rename(join(folder.path, "d"), join(folder.path, "d.kept"));
      await fs.symlink(outside, join(folder.path, "d"));
    };
    expect(await readLentFile(folder, "d/notes.txt", 100)).toEqual({
      ok: false,
      why: "outside-folders",
    });
    await fs.rm(join(folder.path, "d"));
    await fs.rename(join(folder.path, "d.kept"), join(folder.path, "d"));
    const listed = await listLentFolder(folder, "d", 100);
    expect(listed.ok).toBe(false);
  });

  it("is refused when the file itself becomes a link, a FIFO or a hard-linked file", async () => {
    const folder = await lend(join(home, "code", "app"));
    await write(join(home, "secret.txt"), "s3cret");
    const target = join(folder.path, "a.txt");
    for (const swap of [
      () => fs.symlink(join(home, "secret.txt"), target),
      () => fs.link(join(home, "secret.txt"), target),
      async () => execFileSync("mkfifo", [target]),
    ]) {
      await fs.rm(target, { force: true });
      await write(target, "inside");
      betweenCheckAndOpen.run = async () => {
        await fs.rm(target);
        await swap();
      };
      expect(await readLentFile(folder, "a.txt", 100)).toMatchObject({ ok: false });
    }
  });
});
