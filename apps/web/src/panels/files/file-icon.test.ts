import {
  File,
  FileBraces,
  FileCode,
  FileCog,
  FileKey,
  FileLock,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
} from "lucide-react";
import { describe, expect, it } from "vitest";

import { fileIcon } from "./file-icon";

describe("fileIcon", () => {
  it("tells files apart by what they are before their extension", () => {
    expect(fileIcon(".gitignore", "file").icon).toBe(GitBranch);
    expect(fileIcon("package-lock.json", "file").icon).toBe(FileLock);
    expect(fileIcon("bun.lock", "file").icon).toBe(FileLock);
    expect(fileIcon(".env.local", "file").icon).toBe(FileKey);
    expect(fileIcon(".npmrc", "file").icon).toBe(FileCog);
  });

  it("goes by extension, ignoring case, and falls back to a plain file", () => {
    expect(fileIcon("README.MD", "file")).toEqual({ icon: FileText, tone: "text-info" });
    expect(fileIcon("tsconfig.json", "file").icon).toBe(FileBraces);
    expect(fileIcon("retry.ts", "file").icon).toBe(FileCode);
    expect(fileIcon("Makefile", "file").icon).toBe(File);
    expect(fileIcon("latest", "file").icon).toBe(File);
  });

  it("shows folders open or closed", () => {
    expect(fileIcon("src", "dir").icon).toBe(Folder);
    expect(fileIcon("src", "dir", true).icon).toBe(FolderOpen);
  });
});
