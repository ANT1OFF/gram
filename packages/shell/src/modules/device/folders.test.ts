import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
  return checked;
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
