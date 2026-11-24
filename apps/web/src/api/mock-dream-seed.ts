import type { Dream } from "@gram/contracts";

import type { MockFile, MockVersion } from "./mock-dreams";

const INDEX = "MEMORY.md";

export const QUESTIONS = `# Questions for the user

## Q1 · open · 2026-09-21
Should the mail trigger retry when the provider answers 429, or drop the mail and report it?
Source: mail-trigger, thread "Mail trigger queue worker".
Options (pick one):
1. Retry with backoff — five tries, then report it (recommended)
2. Drop and report — the sender resends
3. Park it — hold the mail until someone looks

## Q3 · open · 2026-09-23
The docs repo has no preview deploy. Is a merged PR enough for "preview deployed" there?

## Q2 · answered 2026-09-19
Which repo owns the registry schema?
Answer: web owns it; api reads a generated copy.

## Q4 · decided 2026-09-22
Merge api before web?
Decided: yes. The web client is generated from the api schema, so api lands first. Source: PR api#212.
`;

export const DECISIONS_BEFORE = `# Decisions

- 2026-09-17 · One branch name per feature in every repo (feat/<slug>). Source: mail-trigger.
- 2026-09-18 · The api merges before web, and docs last. Source: PR api#212.
`;

export const DECISIONS_LIVE = `${DECISIONS_BEFORE}- 2026-09-23 · Queue consumers retry with backoff, five times at most. Source: mail-trigger.
`;

export const DECISIONS_DREAM = `# Decisions

- 2026-09-17 · One branch name per feature in every repo (feat/<slug>). Source: mail-trigger.
- 2026-09-18 · Merge order is api, then web, then docs. Source: PR api#212.
- 2026-09-20 · Contracts are agreed in api before web builds against them. Source: registry-paging.
`;

export const seedFiles = (now: number): Map<string, MockFile> => {
  const day = 24 * 60 * 60_000;
  return new Map<string, MockFile>([
    [
      INDEX,
      {
        content:
          "# Memory index\n\n- goals.md: what this workspace is for, in priority order\n- decisions.md: what was decided and why\n- map.md: how api, web and docs relate\n- questions.md: open questions for the user\n- repos/api.md: what working in api taught us\n",
        modifiedAt: now - 6 * day,
      },
    ],
    [
      "goals.md",
      {
        content:
          "# Goals\n\n1. 2026-09-16 · Ship the mail trigger across api, web and docs this quarter.\n2. 2026-09-18 · Page the registry list before it outgrows one response.\n",
        modifiedAt: now - 5 * day,
      },
    ],
    ["decisions.md", { content: DECISIONS_LIVE, modifiedAt: now - 3 * 60 * 60_000 }],
    [
      "map.md",
      {
        content:
          "# Map\n\n- api: the HTTP service; contracts live in api/contracts\n- web: the front end; builds against api's generated client\n- docs: the how-to site; merged last\n",
        modifiedAt: now - 4 * day,
      },
    ],
    ["questions.md", { content: QUESTIONS, modifiedAt: now - day }],
    [
      "repos/api.md",
      {
        content:
          "# api\n\n- 2026-09-19 · `uv run pytest tests/queue` needs Redis on 6380, not the default port.\n",
        modifiedAt: now - 2 * day,
      },
    ],
  ]);
};

/** What `dream.revert` adopts in the mock: the version the update was made from, as a new one. */
export const revertedVersion = (
  memory: { readonly versions: readonly MockVersion[]; readonly current: string },
  dream: Dream,
): MockVersion => {
  const before = memory.versions.find((kept) => kept.version === dream.inputs.memoryVersion);
  if (before === undefined) {
    throw Object.assign(new Error("That memory version no longer exists."), {
      _tag: "NotFound",
      entity: "memory version",
      id: dream.inputs.memoryVersion,
    });
  }
  const next = String(
    Math.max(...memory.versions.map((version) => Number(version.version))) + 1,
  ).padStart(4, "0");
  return {
    version: next,
    adoptedAt: Date.now(),
    files: new Map(before.files),
    source: {
      dreamId: dream.id,
      mode: "review",
      basedOn: memory.current,
      summary: `Reverted what ${dream.adoptedVersion ?? "it"} changed`,
    },
  };
};
