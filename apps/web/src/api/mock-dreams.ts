import {
  DREAM_BUDGET_TOKENS_DEFAULT,
  type Dream,
  type DreamFileDiff,
  type DreamId,
  type DreamMerge,
  type DreamPlan,
  type DreamReview,
  type ImportPreview,
  type MemoryFileInfo,
  type MemoryVersionInfo,
  type MemoryWrite,
  type ModelRef,
  type PermissionMode,
  type Project,
  QUESTIONS_FILE,
  type QuestionEdit,
  type ProjectId,
  type GramUIMessage,
  type Thread,
  type ThreadId,
  type ThreadSummary,
  type UsageSummary,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";

import { MockInvalidState } from "./mock-fs";
import type { AdoptDreamInput, ApiServerEvent, DreamPreviewInput, StartDreamInput } from "./types";

// A workspace's memory and its dreams for MockApi: versions of Markdown files held in maps, and
// dreams whose reviews are written by hand. Nothing here runs an agent. `seed` gives the board
// scenario a memory worth looking at, a completed dream with a conflict and one still running.

export interface MockDreamsHost {
  /** The workspace, or `undefined` for one that doesn't exist. */
  workspace(workspaceId: WorkspaceId): WorkspaceState | undefined;
  projects(): readonly Project[];
  createThread(input: {
    projectRoot: string;
    title: string;
    mode: PermissionMode;
  }): Promise<Thread>;
  /** Stores the thread and emits `thread.upsert`. */
  replace(thread: Thread): void;
  putMessage(threadId: ThreadId, message: GramUIMessage): void;
  setStatus(threadId: ThreadId, status: ThreadSummary["status"], detail?: string): void;
  setUsage(threadId: ThreadId, usage: UsageSummary): void;
  /** Closes the thread as the sidebar would; a thread already gone is no error. */
  closeThread(threadId: ThreadId): Promise<void>;
  emit(event: ApiServerEvent): void;
  ids(): string;
}

const INDEX = "MEMORY.md";
const INDEX_MAX_BYTES = 8 * 1024;
const FILE_MAX_BYTES = 32 * 1024;
const MAX_FILES = 40;
const VERSIONS_KEEP = 6;

interface MockFile {
  readonly content: string;
  readonly modifiedAt: number;
}

interface MockVersion {
  readonly version: string;
  readonly adoptedAt: number;
  readonly files: Map<string, MockFile>;
}

interface MockMemory {
  versions: MockVersion[];
  current: string;
}

/** What a finished mock dream would change, which the real server reads off the dream's folder. */
interface MockOutput {
  readonly files: readonly DreamFileDiff[];
  readonly report: string;
  readonly digest: string;
}

/** One thread's messages past the mock memory's watermark. */
interface MockUnread {
  readonly tokens: number;
  readonly messages: number;
}

/**
 * What a workspace's threads hold that its memory hasn't consolidated, in reading order: 236k
 * tokens, so the default budget of 200k leaves one thread for the next dream.
 */
const MOCK_UNREAD: readonly MockUnread[] = [
  { tokens: 48_000, messages: 60 },
  { tokens: 31_000, messages: 40 },
  { tokens: 22_000, messages: 30 },
  { tokens: 64_000, messages: 32 },
  { tokens: 40_000, messages: 20 },
  { tokens: 31_000, messages: 10 },
];

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

const notFound = (entity: string, id: string) =>
  Object.assign(new Error(`That ${entity} no longer exists.`), { _tag: "NotFound", entity, id });

const fsError = (path: string, message: string) =>
  Object.assign(new Error(message), { _tag: "FsError", path, message });

/** The server's lexical path rule, cut down: a relative POSIX path to a `.md` file. */
const pathProblem = (path: string): string | undefined => {
  if (path === "") return "Name a memory file, e.g. decisions.md";
  if (path.startsWith("/") || path.split("/").some((part) => part === "" || part === "..")) {
    return "A memory path is relative to the memory root, e.g. repos/gram.md";
  }
  if (path.split("/").length > 3) return "A memory file sits at most two folders deep";
  if (!path.endsWith(".md") || path.endsWith("/.md")) {
    return "Memory files are Markdown: end the name in .md";
  }
  return undefined;
};

const QUESTIONS = `# Questions for the user

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

const DECISIONS_BEFORE = `# Decisions

- 2026-09-17 · One branch name per feature in every repo (feat/<slug>). Source: mail-trigger.
- 2026-09-18 · The api merges before web, and docs last. Source: PR api#212.
`;

const DECISIONS_LIVE = `${DECISIONS_BEFORE}- 2026-09-23 · Queue consumers retry with backoff, five times at most. Source: mail-trigger.
`;

const DECISIONS_DREAM = `# Decisions

- 2026-09-17 · One branch name per feature in every repo (feat/<slug>). Source: mail-trigger.
- 2026-09-18 · Merge order is api, then web, then docs. Source: PR api#212.
- 2026-09-20 · Contracts are agreed in api before web builds against them. Source: registry-paging.
`;

const seedFiles = (now: number): Map<string, MockFile> => {
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

/** How long a mock merge "runs", so the panel shows it working. */
const MERGE_MS = 2000;

const sidesOf = (file: DreamFileDiff): string =>
  JSON.stringify([file.before ?? null, file.after ?? null, file.current ?? null]);

const linesOf = (text: string | undefined) => (text ?? "").replace(/\n$/, "").split("\n");

/**
 * What the mock's model makes of a conflict: the dream's text, with every line the orchestrator
 * added since the baseline that the dream doesn't carry, placed after the line it followed or at the
 * end. Enough for the panel to show a believable merge; the real one is a model's.
 */
const mockMerge = (file: Pick<DreamFileDiff, "before" | "after" | "current">): string => {
  const base = new Set(linesOf(file.before));
  const merged = linesOf(file.after);
  const current = linesOf(file.current);
  current.forEach((line, index) => {
    if (base.has(line) || merged.includes(line) || line.trim() === "") return;
    const after = index === 0 ? -1 : merged.indexOf(current[index - 1]!);
    if (after === -1) merged.push(line);
    else merged.splice(after + 1, 0, line);
  });
  return `${merged.join("\n")}\n`;
};

const currentOf = (memory: MockMemory): MockVersion =>
  memory.versions.find((version) => version.version === memory.current)!;

/** The `memory.*` and `dream.*` RPCs for the mock. */
export function createMockDreams(host: MockDreamsHost) {
  const memories = new Map<WorkspaceId, MockMemory>();
  let dreams: Dream[] = [];
  const outputs = new Map<DreamId, MockOutput>();
  const unread = new Map<WorkspaceId, readonly MockUnread[]>();
  /** Which of its workspace's unread threads each dream read, by index: what adopting it consolidates. */
  const readBy = new Map<DreamId, readonly number[]>();
  /** The merges asked for, by dream and path, with the sides each read, as the server keeps them. */
  const merges = new Map<DreamId, Map<string, { sides: string; state: DreamMerge }>>();

  const requireWorkspace = (workspaceId: WorkspaceId): WorkspaceState => {
    const state = host.workspace(workspaceId);
    if (state === undefined) throw notFound("workspace", workspaceId);
    return state;
  };

  const memoryOf = (workspaceId: WorkspaceId): MockMemory => {
    requireWorkspace(workspaceId);
    let memory = memories.get(workspaceId);
    if (memory === undefined) {
      memory = {
        versions: [{ version: "0001", adoptedAt: Date.now(), files: new Map() }],
        current: "0001",
      };
      memories.set(workspaceId, memory);
    }
    return memory;
  };

  const changed = (workspaceId: WorkspaceId) => host.emit({ type: "dreams.changed", workspaceId });

  const findDream = (dreamId: DreamId): Dream => {
    const dream = dreams.find((candidate) => candidate.id === dreamId);
    if (dream === undefined) throw notFound("dream", dreamId);
    return dream;
  };

  const putDream = (next: Dream): Dream => {
    dreams = dreams.some((dream) => dream.id === next.id)
      ? dreams.map((dream) => (dream.id === next.id ? next : dream))
      : [next, ...dreams];
    changed(next.workspaceId);
    return next;
  };

  const dreamId = (): DreamId => `dream-${host.ids()}` as DreamId;

  const assistant = (parts: GramUIMessage["parts"]): GramUIMessage => ({
    id: host.ids(),
    role: "assistant",
    metadata: { createdAt: Date.now() },
    parts,
  });

  /** The server's fill, simplified: whole threads in order while they fit, the rest the backlog. */
  const planOf = (workspaceId: WorkspaceId, budgetTokens: number) => {
    const items = unread.get(workspaceId) ?? MOCK_UNREAD;
    const taken: number[] = [];
    let used = 0;
    for (const [index, item] of items.entries()) {
      if (used + item.tokens > budgetTokens) continue;
      taken.push(index);
      used += item.tokens;
    }
    const left = items.filter((_, index) => !taken.includes(index));
    const plan: DreamPlan = {
      memoryVersion: memoryOf(workspaceId).current,
      fromStart: !dreams.some(
        (dream) => dream.workspaceId === workspaceId && dream.adoptedVersion !== undefined,
      ),
      threads: taken.length,
      messages: taken.reduce((sum, index) => sum + items[index]!.messages, 0),
      estimatedTokens: used,
      budgetTokens,
      backlog: {
        threads: left.length,
        messages: left.reduce((sum, item) => sum + item.messages, 0),
        estimatedTokens: left.reduce((sum, item) => sum + item.tokens, 0),
      },
    };
    const notes =
      left.length === 0
        ? []
        : [
            `${left.length} ${left.length === 1 ? "thread" : "threads"} left for the next dream, past this one's budget. Their watermarks stay where they are, so the next dream reads them.`,
          ];
    return { plan, taken, notes };
  };

  const preview = (state: WorkspaceState, input: DreamPreviewInput): ImportPreview => {
    if (input.kind === "dream") {
      const { plan, notes } = planOf(
        state.workspace.id,
        input.budgetTokens ?? DREAM_BUDGET_TOKENS_DEFAULT,
      );
      return {
        sources: [],
        worktreesCovered: 0,
        worktreesTotal: 0,
        closedThreadsKept: 3,
        archivedThreads: 11,
        notes: [
          ...notes,
          "Transcripts are redacted, stay on this machine, and are read only by the model the dream runs on.",
        ],
        dream: plan,
      };
    }
    const perRepo = input.perRepo ?? 30;
    const day = 24 * 60 * 60_000;
    const now = Date.now();
    const chosen = input.projectIds ?? state.workspace.projectIds;
    const projects = host.projects().filter((project) => chosen.includes(project.id));
    const found: Record<string, number> = { claude: 46, codex: 9 };
    const sources = projects.flatMap((project, index) =>
      (["claude", "codex"] as const).flatMap((agent) => {
        // Only the first repo has Codex history, so a thin source shows beside a rich one.
        if (agent === "codex" && index > 0) return [];
        const sessions = Math.min(perRepo, Math.max(3, found[agent]! - index * 17));
        return [
          {
            projectId: project.id,
            project: project.name,
            agent,
            cwd: project.root,
            sessions,
            oldest: now - (120 - index * 30) * day,
            newest: now - (index + 1) * day,
            estimatedTokens: sessions * (agent === "claude" ? 18_400 : 9_200),
          },
        ];
      }),
    );
    return {
      sources,
      worktreesCovered: 4,
      worktreesTotal: 4,
      closedThreadsKept: 3,
      archivedThreads: 11,
      ...(input.includeMemory === true ? { seedFiles: 7 } : {}),
      notes: [
        "Sessions from worktrees that have since been removed can't be listed, so they aren't counted here.",
        ...(sources.some((source) => source.sessions >= perRepo)
          ? [`Only the newest ${perRepo} sessions per repo and agent are read.`]
          : []),
      ],
    };
  };

  return {
    async list(workspaceId: WorkspaceId): Promise<readonly MemoryFileInfo[]> {
      return [...currentOf(memoryOf(workspaceId)).files]
        .map(([path, file]) => ({
          path,
          bytes: bytesOf(file.content),
          modifiedAt: file.modifiedAt,
        }))
        .toSorted((a, b) => a.path.localeCompare(b.path));
    },

    /**
     * The orchestrator's `ask_user` or `close_question`, as the server runs them: `questions.md` is
     * rewritten with what `edit` makes of it, and only `memory.changed` goes out. Resolves to the
     * entry's id.
     */
    editQuestions(
      workspaceId: WorkspaceId,
      edit: (current: string | undefined) => QuestionEdit,
    ): string {
      const { files } = currentOf(memoryOf(workspaceId));
      const done = edit(files.get(QUESTIONS_FILE)?.content);
      if (!done.ok) throw new MockInvalidState(done.problem);
      files.set(QUESTIONS_FILE, { content: done.content, modifiedAt: Date.now() });
      host.emit({ type: "memory.changed", workspaceId });
      return done.id;
    },

    async read(workspaceId: WorkspaceId, path: string) {
      const file = currentOf(memoryOf(workspaceId)).files.get(path);
      if (file === undefined) throw fsError(path, `${path} isn't in memory.`);
      return { path, content: file.content };
    },

    async write(workspaceId: WorkspaceId, path: string, content: string): Promise<MemoryWrite> {
      const { files } = currentOf(memoryOf(workspaceId));
      const problem = pathProblem(path);
      if (problem !== undefined) throw new MockInvalidState(problem);
      const bytes = bytesOf(content);
      const cap = path === INDEX ? INDEX_MAX_BYTES : FILE_MAX_BYTES;
      if (bytes > cap) {
        throw new MockInvalidState(
          `${path} would be ${bytes} bytes; the cap is ${cap}. Trim it, or run a dream to consolidate.`,
        );
      }
      if (!files.has(path) && files.size >= MAX_FILES) {
        throw new MockInvalidState(`Memory holds at most ${MAX_FILES} files.`);
      }
      const before = files.get(path)?.content;
      files.set(path, { content, modifiedAt: Date.now() });
      changed(workspaceId);
      return {
        path,
        action: "write",
        ...(before === undefined ? {} : { before }),
        after: content,
        bytes,
      };
    },

    async delete(workspaceId: WorkspaceId, path: string): Promise<MemoryWrite> {
      const { files } = currentOf(memoryOf(workspaceId));
      const before = files.get(path)?.content;
      if (before === undefined) throw fsError(path, `${path} isn't in memory.`);
      files.delete(path);
      changed(workspaceId);
      return { path, action: "delete", before, bytes: 0 };
    },

    async versions(workspaceId: WorkspaceId): Promise<readonly MemoryVersionInfo[]> {
      const memory = memoryOf(workspaceId);
      return memory.versions.map((version) => ({
        version: version.version,
        adoptedAt: version.adoptedAt,
        files: version.files.size,
        current: version.version === memory.current,
      }));
    },

    async restore(workspaceId: WorkspaceId, version: string): Promise<void> {
      const memory = memoryOf(workspaceId);
      if (!memory.versions.some((kept) => kept.version === version)) {
        throw notFound("memory version", version);
      }
      memory.current = version;
      changed(workspaceId);
    },

    async preview(workspaceId: WorkspaceId, input: DreamPreviewInput = {}): Promise<ImportPreview> {
      return preview(requireWorkspace(workspaceId), input);
    },

    async start(workspaceId: WorkspaceId, input: StartDreamInput): Promise<Dream> {
      const state = requireWorkspace(workspaceId);
      const running = dreams.find(
        (dream) =>
          dream.workspaceId === workspaceId &&
          (dream.status === "running" || dream.status === "pending"),
      );
      if (running !== undefined) {
        throw new MockInvalidState(
          "A dream is already running for this workspace. Wait for it, or cancel it first.",
        );
      }
      const home = host.projects().find((p) => p.id === state.workspace.homeProjectId);
      if (home === undefined) throw notFound("project", state.workspace.homeProjectId);
      const created = await host.createThread({
        projectRoot: home.root,
        title: input.kind === "import" ? "Import history" : "Dream",
        mode: "acceptEdits",
      });
      const thread: Thread = { ...created, role: "dream", workspaceId };
      host.replace(thread);
      host.setStatus(thread.id, "running", "reading input/sessions");
      const model: ModelRef = input.model ?? { agent: "claude", model: "default" };
      const memory = memoryOf(workspaceId);
      const empty = currentOf(memory).files.size === 0;
      const id = dreamId();
      const planned =
        input.kind === "dream"
          ? planOf(workspaceId, input.budgetTokens ?? DREAM_BUDGET_TOKENS_DEFAULT)
          : undefined;
      if (planned !== undefined) readBy.set(id, planned.taken);
      return putDream({
        id,
        workspaceId,
        kind: input.kind,
        mode: input.mode ?? "review",
        status: "running",
        inputs: {
          memoryVersion: empty ? "" : memory.current,
          threadIds: [...(input.threadIds ?? [])],
          agentSessions: [...(input.agentSessions ?? [])],
        },
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        model,
        threadId: thread.id,
        outputDir: `/mock/orchestration/${workspaceId}/dreams/${thread.id}`,
        createdAt: Date.now(),
        ...(planned === undefined
          ? {}
          : {
              budgetTokens: planned.plan.budgetTokens,
              backlog: planned.plan.backlog,
              ...(planned.notes.length === 0 ? {} : { notes: planned.notes }),
            }),
      });
    },

    async listDreams(workspaceId: WorkspaceId): Promise<readonly Dream[]> {
      requireWorkspace(workspaceId);
      return dreams
        .filter((dream) => dream.workspaceId === workspaceId)
        .toSorted((a, b) => b.createdAt - a.createdAt);
    },

    async review(id: DreamId): Promise<DreamReview> {
      const dream = findDream(id);
      const output = outputs.get(id);
      const memory = memoryOf(dream.workspaceId);
      const live = currentOf(memory).files;
      return {
        dream,
        memoryVersion: memory.current,
        ...(output === undefined ? {} : { outputDigest: output.digest, report: output.report }),
        // A file the orchestrator wrote since the dream copied it is a conflict, and says what
        // memory holds now; once memory and the baseline agree again it is an ordinary change.
        files: (output?.files ?? []).map((file) => {
          const current = live.get(file.path)?.content;
          if (file.status !== "conflict") return file;
          if (current === file.before) {
            const { current: _current, ...rest } = file;
            return { ...rest, status: "changed" as const };
          }
          const conflict: DreamFileDiff = {
            ...file,
            ...(current === undefined ? {} : { current }),
          };
          const merge = merges.get(id)?.get(file.path);
          return merge !== undefined && merge.sides === sidesOf(conflict)
            ? { ...conflict, merge: merge.state }
            : conflict;
        }),
      };
    },

    async cancel(id: DreamId): Promise<Dream> {
      const dream = findDream(id);
      if (dream.status !== "running" && dream.status !== "pending") {
        throw new MockInvalidState("Only a running dream can be cancelled.");
      }
      if (dream.threadId !== undefined) host.setStatus(dream.threadId, "idle");
      return putDream({ ...dream, status: "canceled", failure: "canceled", endedAt: Date.now() });
    },

    async adopt(id: DreamId, input: AdoptDreamInput = {}): Promise<Dream> {
      const dream = findDream(id);
      const output = outputs.get(id);
      if (dream.status !== "completed" || output === undefined) {
        throw new MockInvalidState("Only a completed dream can be adopted.");
      }
      if (dream.adoptedVersion !== undefined) {
        throw new MockInvalidState(`This dream was adopted already, as ${dream.adoptedVersion}.`);
      }
      const memory = memoryOf(dream.workspaceId);
      if (input.basedOn !== undefined && input.basedOn !== memory.current) {
        throw new MockInvalidState(
          `Memory was adopted or restored since this review (it is version ${memory.current} now). Review the dream again.`,
        );
      }
      if (input.outputDigest !== undefined && input.outputDigest !== output.digest) {
        throw new MockInvalidState(
          "The dream's output was changed since this review. Review the dream again.",
        );
      }
      const review = await this.review(id);
      const unresolved = review.files.filter(
        (file) => file.status === "conflict" && input.resolutions?.[file.path] === undefined,
      );
      if (unresolved.length > 0) {
        throw new MockInvalidState(
          `Choose a side for ${unresolved.map((file) => file.path).join(", ")} first.`,
        );
      }
      const unmerged = review.files.filter(
        (file) =>
          file.status === "conflict" &&
          input.resolutions?.[file.path] === "merged" &&
          file.merge?.status !== "done",
      );
      if (unmerged.length > 0) {
        throw new MockInvalidState(
          `There is no finished merge of ${unmerged.map((file) => file.path).join(", ")} as memory and the dream's output hold it now. Merge it again, or choose a side.`,
        );
      }
      const now = Date.now();
      const files = new Map(currentOf(memory).files);
      for (const file of review.files) {
        const side = file.status === "conflict" ? input.resolutions?.[file.path] : undefined;
        if (file.status === "unchanged" || side === "current") continue;
        const content = side === "merged" ? file.merge?.merged : file.after;
        if (content === undefined) files.delete(file.path);
        else files.set(file.path, { content, modifiedAt: now });
      }
      const next = String(
        Math.max(...memory.versions.map((version) => Number(version.version))) + 1,
      ).padStart(4, "0");
      memory.versions = [...memory.versions, { version: next, adoptedAt: now, files }].slice(
        -VERSIONS_KEEP,
      );
      memory.current = next;
      merges.delete(id);
      const read = readBy.get(id);
      if (read !== undefined) {
        const items = unread.get(dream.workspaceId) ?? MOCK_UNREAD;
        unread.set(
          dream.workspaceId,
          items.filter((_, index) => !read.includes(index)),
        );
      }
      return putDream({ ...dream, adoptedVersion: next });
    },

    async merge(id: DreamId, path: string): Promise<DreamMerge> {
      const dream = findDream(id);
      if (dream.adoptedVersion !== undefined) {
        throw new MockInvalidState(
          `That dream was already adopted as version ${dream.adoptedVersion}.`,
        );
      }
      if (dream.status !== "completed") {
        throw new MockInvalidState("Only a completed dream's conflicts can be merged.");
      }
      const file = (await this.review(id)).files.find((candidate) => candidate.path === path);
      if (file?.status !== "conflict") {
        throw new MockInvalidState(`${path} isn't a conflict of this dream's review.`);
      }
      if (file.after === undefined || file.current === undefined) {
        throw new MockInvalidState(
          `One side removed ${path}, so there are not two versions to merge. Take the dream's or keep memory's.`,
        );
      }
      if (file.merge?.status === "running") return file.merge;
      const started: DreamMerge = { status: "running", model: dream.model, startedAt: Date.now() };
      const entry = { sides: sidesOf(file), state: started };
      const made = merges.get(id) ?? new Map();
      made.set(path, entry);
      merges.set(id, made);
      changed(dream.workspaceId);
      setTimeout(() => {
        if (entry.state !== started) return;
        entry.state = { ...started, status: "done", merged: mockMerge(file), endedAt: Date.now() };
        changed(dream.workspaceId);
      }, MERGE_MS);
      return started;
    },

    async discard(id: DreamId): Promise<void> {
      const dream = findDream(id);
      if (dream.status === "running" || dream.status === "pending") {
        throw new MockInvalidState("The dream is still running: cancel it first.");
      }
      // As the server does: the thread ran in the folder a discard deletes, so it is closed first.
      if (dream.threadId !== undefined) await host.closeThread(dream.threadId);
      dreams = dreams.filter((candidate) => candidate.id !== id);
      outputs.delete(id);
      merges.delete(id);
      changed(dream.workspaceId);
    },

    /**
     * The board scenario's memory: two versions, the adopted one with a `questions.md` holding two
     * open questions; a completed dream that changes `decisions.md`, which the orchestrator wrote
     * after the dream copied it (a conflict), adds a file and removes one; and a dream still running.
     */
    async seed(workspaceId: WorkspaceId, projectIds: readonly ProjectId[]): Promise<void> {
      const state = requireWorkspace(workspaceId);
      if (memories.has(workspaceId)) return;
      const now = Date.now();
      const day = 24 * 60 * 60_000;
      const files = seedFiles(now);
      const first = new Map(
        [...files].filter(([path]) => path === INDEX || path === "goals.md" || path === "map.md"),
      );
      memories.set(workspaceId, {
        versions: [
          { version: "0001", adoptedAt: now - 8 * day, files: first },
          { version: "0002", adoptedAt: now - 3 * day, files },
        ],
        current: "0002",
      });
      const home = host.projects().find((p) => p.id === state.workspace.homeProjectId);
      if (home === undefined) throw notFound("project", state.workspace.homeProjectId);

      const spawn = async (title: string): Promise<Thread> => {
        const created = await host.createThread({
          projectRoot: home.root,
          title,
          mode: "acceptEdits",
        });
        const thread: Thread = { ...created, role: "dream", workspaceId };
        host.replace(thread);
        return thread;
      };

      const report =
        "# Dream report\n\n## Merged\n- Two entries about merge order in decisions.md said the same thing; kept one. Source: PR api#212.\n\n## Dropped\n- repos/docs-notes.md: a one-off debugging note from 2026-09-12 that no later session used.\n\n## New\n- conventions.md: branch names and who reviews what. Sources: mail-trigger, registry-paging.\n\n## Unresolved\n- Whether docs needs a preview deploy: left as Q3 in questions.md.\n";
      const conventions =
        "# Conventions\n\n- 2026-09-17 · Branches are feat/<slug>, the same in every repo of a feature. Source: mail-trigger.\n- 2026-09-20 · The repo's code owners review; the AI reviewer's approval is enough to merge. Source: registry-paging.\n";
      const finished = await spawn("Dream");
      const completedId = dreamId();
      const reviewFiles: DreamFileDiff[] = [
        { path: "conventions.md", status: "added", after: conventions },
        {
          path: "decisions.md",
          status: "conflict",
          before: DECISIONS_BEFORE,
          after: DECISIONS_DREAM,
          current: DECISIONS_LIVE,
        },
        { path: "goals.md", status: "unchanged", before: files.get("goals.md")!.content },
        {
          path: "map.md",
          status: "changed",
          before: files.get("map.md")!.content,
          after: `${files.get("map.md")!.content}- merge order: api, then web, then docs\n`,
        },
        {
          path: "repos/docs-notes.md",
          status: "removed",
          before: "# docs\n\n- 2026-09-12 · The link checker timed out once; rerunning fixed it.\n",
        },
      ];
      outputs.set(completedId, {
        files: reviewFiles,
        report,
        digest: "sha256:mock-output-1",
      });
      host.setUsage(finished.id, {
        tokens: { inputTokens: 412_000, outputTokens: 9_800 },
        costUsd: 2.35,
      });
      host.putMessage(
        finished.id,
        assistant([
          { type: "text", text: "Both passes are done. The report says what changed and why." },
          {
            type: "data-dream-report",
            id: host.ids(),
            data: {
              dreamId: completedId,
              status: "completed",
              files: reviewFiles.map(({ path, status }) => ({ path, status })),
              reportExcerpt: report.slice(0, 600),
            },
          },
        ]),
      );
      const running = await spawn("Import history");
      host.setStatus(running.id, "running", "reading input/sessions/0007.md");
      const base = {
        workspaceId,
        outputDir: `/mock/orchestration/${workspaceId}/dreams`,
        mode: "review" as const,
        inputs: { memoryVersion: "0002", threadIds: [], agentSessions: [] },
      };
      dreams = [
        {
          ...base,
          id: dreamId(),
          kind: "import",
          status: "running",
          model: { agent: "codex", model: "gpt-5-codex" },
          threadId: running.id,
          createdAt: now - 4 * 60_000,
          notes: [`Only the newest 30 sessions of ${projectIds.length} repos were read.`],
        },
        {
          ...base,
          id: completedId,
          kind: "dream",
          status: "completed",
          model: { agent: "claude", model: "opus" },
          threadId: finished.id,
          usage: { tokens: { inputTokens: 412_000, outputTokens: 9_800 }, costUsd: 2.35 },
          createdAt: now - 5 * 60 * 60_000,
          endedAt: now - 5 * 60 * 60_000 + 11 * 60_000,
        },
        {
          ...base,
          id: dreamId(),
          kind: "dream",
          status: "failed",
          failure: "input_tampered",
          model: { agent: "claude", model: "opus" },
          createdAt: now - 2 * day,
          endedAt: now - 2 * day + 6 * 60_000,
        },
        ...dreams,
      ];
      changed(workspaceId);
    },
  };
}
