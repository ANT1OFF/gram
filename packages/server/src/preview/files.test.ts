import { describe, expect, it } from "vitest";

import {
  emptyPreviewFolders,
  filesWrittenBy,
  lookupPreview,
  prefixFor,
  servedFrom,
} from "./files.ts";

describe("preview folders", () => {
  it("keeps one prefix per folder and forgets the least recently shown past the cap", () => {
    const folders = emptyPreviewFolders();
    let n = 0;
    const mint = () => `p${++n}`;
    expect(prefixFor(folders, "/a", 2, mint)).toBe("p1");
    expect(prefixFor(folders, "/b", 2, mint)).toBe("p2");
    // Shown again: the same prefix, and now the most recent.
    expect(prefixFor(folders, "/a", 2, mint)).toBe("p1");
    expect(prefixFor(folders, "/c", 2, mint)).toBe("p3");
    expect([...folders.byPrefix.keys()]).toEqual(["p1", "p3"]);
    expect(folders.byFolder.has("/b")).toBe(false);
  });

  it("answers only paths under the segment and a known prefix, with no dotfile, escape or credential", () => {
    const folders = emptyPreviewFolders();
    const prefix = `gram-preview-files/${prefixFor(folders, "/r", 64, () => "tok")}`;
    expect(lookupPreview(folders, `/${prefix}/index.html?x=1`)).toEqual({
      kind: "file",
      folder: "/r",
      relative: "index.html",
    });
    expect(lookupPreview(folders, `/${prefix}/assets/a%20b.css`)).toMatchObject({
      relative: "assets/a b.css",
    });
    for (const path of [
      "/other/index.html",
      "/tok/index.html",
      "/GRAM-PREVIEW-FILES/tok/index.html",
      `/${prefix}`,
      `/${prefix}/`,
      `/${prefix}/../x`,
      `/${prefix}/..%2Fx`,
      `/${prefix}/a%5Cb`,
      `/${prefix}/.git/config`,
      `/${prefix}/.env`,
      `/${prefix}/keys/server.pem`,
      `/${prefix}/id_ed25519`,
      `/${prefix}/credentials.json`,
      `/${prefix}/secrets.yaml`,
      `/${prefix}/aws/.aws/config`,
      `/${prefix}/%E0%A4%A`,
    ]) {
      expect(lookupPreview(folders, path), path).toEqual({ kind: "notFound" });
    }
  });
});

describe("filesWrittenBy", () => {
  it("names the files a message's finished Write and Edit calls changed, Codex's included", () => {
    const done = { state: "output-available" };
    expect(
      filesWrittenBy({
        parts: [
          { type: "text", text: "/tmp/said.html" },
          { type: "tool-Write", ...done, input: { file_path: "/tmp/a.html" } },
          { type: "tool-Edit", ...done, input: { changes: [{ path: "/tmp/b.md" }, { path: 3 }] } },
          { type: "tool-Read", ...done, input: { file_path: "/tmp/read.html" } },
          { type: "tool-Write", state: "output-error", input: { file_path: "/tmp/failed.html" } },
          { type: "tool-Write", state: "output-denied", input: { file_path: "/tmp/denied.html" } },
          { type: "tool-Write", state: "input-available", input: { file_path: "/tmp/running.md" } },
          { type: "tool-Write", ...done },
          null,
        ],
      }),
    ).toEqual(["/tmp/a.html", "/tmp/b.md"]);
  });
});

describe("servedFrom", () => {
  it("serves a resolved path inside the folder and through no dot segment", () => {
    expect(servedFrom("/r", "/r/index.html")).toBe(true);
    expect(servedFrom("/r", "/r/assets/a.css")).toBe(true);
    expect(servedFrom("/r", "/r/.env")).toBe(false);
    expect(servedFrom("/r", "/r/.git/config")).toBe(false);
    expect(servedFrom("/r", "/r2/index.html")).toBe(false);
    expect(servedFrom("/r", "/etc/passwd")).toBe(false);
  });
});
