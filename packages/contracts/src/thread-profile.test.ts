import { describe, expect, it } from "vitest";
import {
  decodeThreadProfile,
  PROFILE_FILES_MAX,
  PROFILE_FILES_MAX_BYTES,
  PROFILE_SKILLS_DIR,
  profileBindingOf,
  profileFilesOf,
  profilePathProblem,
  ProfileStartRequest,
  ProfileStartResponse,
  ProfileWaitRequest,
  type ThreadProfile,
} from "./thread-profile.ts";
import * as Schema from "effect/Schema";
import { AwaitingMachine, ProfileAutonomy, profileAutonomyOf } from "./domain.ts";
import { AWAITED_HOST_ID, LOCAL_HOST_ID } from "./hosts.ts";
import { Autonomy } from "./workspaces.ts";

const minimal: ThreadProfile = {
  version: 1,
  agent: "claude",
  charter: "",
  model: { model: "some-model" },
  connectors: {},
  workplace: { kind: "none" },
};

const problemsOf = (value: unknown): ReadonlyArray<string> => {
  const decoded = decodeThreadProfile(value);
  return decoded.ok ? [] : decoded.problems;
};

/** What is wrong with a profile whose one MCP server is this. */
const server = (url: string, name = "workspace") =>
  problemsOf({ ...minimal, connectors: { server: { name, url } } });

/** What is wrong with a profile that works in these repositories. */
const repositories = (list: ReadonlyArray<unknown>) =>
  problemsOf({ ...minimal, workplace: { kind: "repositories", repositories: list } });

describe("ThreadProfile", () => {
  it("takes the least a profile can say, and everything it can", () => {
    expect(decodeThreadProfile(minimal)).toEqual({ ok: true, profile: minimal });
    const full: ThreadProfile = {
      version: 1,
      name: "Triage",
      source: { id: "t-1", version: "9" },
      agent: "codex",
      charter: "Triage new issues.",
      files: [{ path: "AGENTS.md", content: "Rules.\n" }],
      skills: [{ name: "label-issues", description: "Labels issues.", body: "Steps." }],
      model: {
        model: "some-model",
        effort: "medium",
        gatewayProfile: "gateway-1" as never,
        fallbacks: [{ model: "other", effort: "low" }],
      },
      connectors: { server: { name: "workspace", url: "http://mcp.platform.svc:8080/w/1" } },
      autonomy: "full",
      workplace: {
        kind: "repositories",
        repositories: [
          { url: "https://git.example.test/team/app.git", ref: "main", branch: "agent/triage" },
        ],
      },
      input: "Start.",
    };
    expect(decodeThreadProfile(full)).toEqual({ ok: true, profile: full });
  });

  it("refuses a key it doesn't know rather than dropping it", () => {
    expect(problemsOf({ ...minimal, mandate: {} })[0]).toContain("mandate");
    expect(problemsOf({ ...minimal, connectors: { namespaces: ["github"] } })[0]).toContain(
      "namespaces",
    );
    expect(
      problemsOf({
        ...minimal,
        connectors: {
          server: { name: "w", url: "https://mcp.example.test", headers: { authorization: "x" } },
        },
      })[0],
    ).toContain("headers");
  });

  it("refuses another version, another agent and a missing part", () => {
    expect(decodeThreadProfile({ ...minimal, version: 2 }).ok).toBe(false);
    expect(decodeThreadProfile({ ...minimal, agent: "custom" }).ok).toBe(false);
    const { workplace: _, ...noWorkplace } = minimal;
    expect(decodeThreadProfile(noWorkplace).ok).toBe(false);
    expect(decodeThreadProfile("profile").ok).toBe(false);
  });

  it("keeps files inside the folder and out of .git", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "C:/Users/x",
      "../up",
      "a/../../up",
      "a//b",
      "./a",
      "a/.",
      "a\\b",
      "a\u0000b",
      ".git/config",
      "sub/.GIT/hooks/pre-commit",
      ".git./config",
      ".git /config",
      "git~1/config",
      ".git::$INDEX_ALLOCATION/x",
      "dir/a:b",
      "CON",
      "sub/nul.txt",
      "trailing./x",
      " lead/x",
      "what?.md",
      "x".repeat(301),
    ]) {
      expect(profilePathProblem(path), path).toBeTypeOf("string");
      expect(decodeThreadProfile({ ...minimal, files: [{ path, content: "" }] }).ok, path).toBe(
        false,
      );
    }
    for (const path of ["AGENTS.md", ".claude/settings.json", "docs/a b.md", ".gitignore"]) {
      expect(profilePathProblem(path), path).toBeUndefined();
    }
  });

  it("refuses two files at one path, a skill's among them, and too much to lay", () => {
    expect(
      problemsOf({
        ...minimal,
        files: [
          { path: "notes.md", content: "" },
          { path: "Notes.md", content: "" },
        ],
      }),
    ).toEqual(["Two files are laid at Notes.md."]);
    // Composed and decomposed, one name on some disks.
    expect(
      problemsOf({
        ...minimal,
        files: [
          { path: "caf\u00e9.md", content: "" },
          { path: "cafe\u0301.md", content: "" },
        ],
      }),
    ).toHaveLength(1);
    // A file where another's folder would be.
    expect(
      problemsOf({
        ...minimal,
        files: [
          { path: "notes", content: "" },
          { path: "notes/today.md", content: "" },
        ],
      }),
    ).toEqual(["notes/today.md is inside a path another file is laid at."]);
    const skill = { name: "ship", description: "Ships.", body: "Do it." };
    expect(problemsOf({ ...minimal, skills: [skill, skill] })).toContain(
      "Two skills are named ship.",
    );
    expect(
      problemsOf({
        ...minimal,
        files: [{ path: ".claude/skills/ship/SKILL.md", content: "" }],
        skills: [skill],
      }),
    ).toEqual(["Two files are laid at .claude/skills/ship/SKILL.md."]);
    expect(
      problemsOf({
        ...minimal,
        skills: [{ ...skill, files: [{ path: "SKILL.md", content: "" }] }],
      })[0],
    ).toContain("SKILL.md");
    expect(
      problemsOf({
        ...minimal,
        files: Array.from({ length: PROFILE_FILES_MAX + 1 }, (_, i) => ({
          path: `f${i}`,
          content: "",
        })),
      })[0],
    ).toContain(`at most ${PROFILE_FILES_MAX} files`);
    expect(
      problemsOf({
        ...minimal,
        files: [{ path: "big", content: "é".repeat(PROFILE_FILES_MAX_BYTES / 2 + 1) }],
      })[0],
    ).toContain("bytes");
    expect(decodeThreadProfile({ ...minimal, skills: [{ ...skill, name: "Not A Slug" }] }).ok).toBe(
      false,
    );
  });

  it("takes an MCP server by a plain http or https address only", () => {
    expect(server("https://mcp.example.test/w/1")).toEqual([]);
    expect(server("http://mcp.platform.svc:8080")).toEqual([]);
    for (const url of [
      "mcp.example.test",
      "ftp://mcp.example.test",
      "https://user@mcp.example.test",
      "https://mcp.example.test/?token=abc",
      "https://mcp.example.test/#frag",
      "https://*.example.test/",
      "https://mcp.example.test/w\n",
      " https://mcp.example.test/w",
      "https://",
    ]) {
      expect(server(url), url).toHaveLength(1);
    }
    expect(server("https://mcp.example.test", "gram")[0]).toContain("Gram's own");
    expect(server("https://mcp.example.test", "Gram")[0]).toContain("Gram's own");
  });

  it("wants one to eight repositories, each ref a plain name", () => {
    const url = "https://git.example.test/team/app.git";
    expect(repositories([])).toHaveLength(1);
    expect(repositories(Array.from({ length: 9 }, () => ({ url })))).toHaveLength(1);
    expect(repositories([{ url, ref: "--upload-pack=x" }])).toHaveLength(1);
    expect(repositories([{ url, branch: "a b" }])).toHaveLength(1);
    expect(repositories([{ url, ref: "v1.2.0", branch: "agent/fix" }])).toEqual([]);
  });

  it("writes each skill where its agent reads a folder's skills", () => {
    const skills = [
      {
        name: "ship-it",
        description: "Ships: carefully.",
        body: "Run the checks.\n",
        files: [{ path: "scripts/check.sh", content: "#!/bin/sh\n" }],
      },
    ];
    const files = [{ path: "AGENTS.md", content: "Rules.\n" }];
    expect(PROFILE_SKILLS_DIR).toEqual({ claude: ".claude/skills", codex: ".agents/skills" });
    expect(profileFilesOf({ agent: "claude", files, skills })).toEqual([
      { path: "AGENTS.md", content: "Rules.\n" },
      {
        path: ".claude/skills/ship-it/SKILL.md",
        content: '---\nname: ship-it\ndescription: "Ships: carefully."\n---\n\nRun the checks.\n',
      },
      { path: ".claude/skills/ship-it/scripts/check.sh", content: "#!/bin/sh\n" },
    ]);
    expect(profileFilesOf({ agent: "codex", skills }).map((file) => file.path)).toEqual([
      ".agents/skills/ship-it/SKILL.md",
      ".agents/skills/ship-it/scripts/check.sh",
    ]);
    expect(profileFilesOf({ agent: "claude" })).toEqual([]);
  });

  it("keeps on the thread what its sessions and its supplier need, and no file", () => {
    expect(profileBindingOf(minimal)).toEqual({ charter: "" });
    expect(
      profileBindingOf({
        ...minimal,
        name: "Triage",
        source: { id: "t-1" },
        charter: "Triage.",
        files: [{ path: "AGENTS.md", content: "Rules." }],
        model: { model: "m", fallbacks: [{ model: "n" }] },
        connectors: { server: { name: "w", url: "https://mcp.example.test" } },
        autonomy: "full",
        input: "Go.",
      }),
    ).toEqual({
      name: "Triage",
      source: { id: "t-1" },
      charter: "Triage.",
      autonomy: "full",
      server: { name: "w", url: "https://mcp.example.test" },
      fallbacks: [{ model: "n" }],
    });
  });

  it("has a workspace's autonomy levels, publish when it names none", () => {
    expect(ProfileAutonomy.literals).toEqual(Autonomy.literals);
    expect(profileAutonomyOf({})).toBe("publish");
    expect(profileAutonomyOf({ autonomy: "full" })).toBe("full");
  });

  it("starts a thread with its machine named later, and says how its wait stands", () => {
    const start = Schema.decodeUnknownSync(ProfileStartRequest, { onExcessProperty: "error" });
    const threadId = "6b1d2a90-3c4e-4f5a-8b6c-7d8e9f0a1b2c";
    // A caller that knows nothing of it sends what it always sent.
    expect(start({ profile: minimal, threadId })).toEqual({ profile: minimal, threadId });
    expect(start({ profile: minimal, threadId, machine: "later", startedBy: "ada" })).toEqual({
      profile: minimal,
      threadId,
      machine: "later",
      startedBy: "ada",
    });
    expect(() => start({ profile: minimal, threadId, machine: "now" })).toThrow();
    // An answer read by a caller that doesn't know the field is the answer it knew.
    const answer = Schema.decodeUnknownSync(ProfileStartResponse);
    expect(answer({ threadId, created: true })).toEqual({ threadId, created: true });
    expect(answer({ threadId, created: true, awaitingMachine: true }).awaitingMachine).toBe(true);
    const wait = Schema.decodeUnknownSync(ProfileWaitRequest, { onExcessProperty: "error" });
    expect(wait({ threadId })).toEqual({ threadId });
    expect(wait({ threadId, failed: "No capacity." }).failed).toBe("No capacity.");
    const waiting = Schema.decodeUnknownSync(AwaitingMachine);
    expect(waiting({ since: 1 })).toEqual({ since: 1 });
    expect(waiting({ since: 1, startedBy: "ada", failed: { at: 2, message: "No." } })).toEqual({
      since: 1,
      startedBy: "ada",
      failed: { at: 2, message: "No." },
    });
    // The machine of a thread that has none is no machine's id, this one's included.
    expect(AWAITED_HOST_ID).not.toBe(LOCAL_HOST_ID);
    expect(AWAITED_HOST_ID.startsWith("m-")).toBe(false);
  });
});
