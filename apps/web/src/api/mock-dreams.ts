import {
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
  memoryUpdateModeOf,
} from "@gram/contracts";

import { failDreamSoon } from "./mock-dream-fails";
import {
  DECISIONS_BEFORE,
  DECISIONS_DREAM,
  DECISIONS_LIVE,
  revertedVersion,
  seedFiles,
} from "./mock-dream-seed";
import { mockMerge, sidesOf } from "./mock-dream-merge";
import { MockInvalidState } from "./mock-fs";
import type { AdoptDreamInput, ApiServerEvent, DreamPreviewInput, StartDreamInput } from "./types";

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

export interface MockFile {
  readonly content: string;
  readonly modifiedAt: number;
}

export interface MockVersion {
  readonly version: string;
  readonly adoptedAt: number;
  readonly files: Map<string, MockFile>;
  readonly source?: Pick<MemoryVersionInfo, "dreamId" | "mode" | "summary" | "basedOn">;
}

interface MockMemory {
  versions: MockVersion[];
  current: string;
}

interface MockOutput {
  readonly files: readonly DreamFileDiff[];
  readonly report: string;
  readonly digest: string;
}

interface MockRecent {
  readonly reports: number;
  readonly merges: number;
  readonly questions: number;
  readonly threads: number;
}

const MOCK_RECENT: MockRecent = { reports: 7, merges: 3, questions: 2, threads: 5 };
const TOKENS_PER_ITEM = 320;

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

const notFound = (entity: string, id: string) =>
  Object.assign(new Error(`That ${entity} no longer exists.`), { _tag: "NotFound", entity, id });

const fsError = (path: string, message: string) =>
  Object.assign(new Error(message), { _tag: "FsError", path, message });

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

const MERGE_MS = 2000;

const currentOf = (memory: MockMemory): MockVersion =>
  memory.versions.find((version) => version.version === memory.current)!;

/** The `memory.*` and `dream.*` RPCs for the mock. */
export function createMockDreams(host: MockDreamsHost) {
  const memories = new Map<WorkspaceId, MockMemory>();
  let dreams: Dream[] = [];
  const outputs = new Map<DreamId, MockOutput>();
  const recent = new Map<WorkspaceId, MockRecent>();
  const lastAdopted = new Map<WorkspaceId, number>();
  const modes = new Map<WorkspaceId, "review" | "auto">();
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

  const planOf = (workspaceId: WorkspaceId): DreamPlan => {
    const since = recent.get(workspaceId) ?? MOCK_RECENT;
    const items = since.reports + since.merges + since.questions + since.threads;
    return {
      memoryVersion: memoryOf(workspaceId).current,
      sinceAt: lastAdopted.get(workspaceId) ?? Date.now() - 6 * 60 * 60_000,
      ...since,
      estimatedTokens: 300 + items * TOKENS_PER_ITEM,
    };
  };

  const preview = (state: WorkspaceState, input: DreamPreviewInput): ImportPreview => {
    if (input.kind === "dream") {
      return {
        sources: [],
        worktreesCovered: 0,
        worktreesTotal: 0,
        closedThreadsKept: 3,
        archivedThreads: 11,
        notes: [],
        dream: planOf(state.workspace.id),
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
          `${path} would be ${bytes} bytes; the cap is ${cap}. Trim it, or start a memory update to consolidate.`,
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
        ...version.source,
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
          "A memory update is already running for this workspace. Wait for it, or cancel it first.",
        );
      }
      const home = host.projects().find((p) => p.id === state.workspace.homeProjectId);
      if (home === undefined) throw notFound("project", state.workspace.homeProjectId);
      const created = await host.createThread({
        projectRoot: home.root,
        title: input.kind === "import" ? "Import history" : "Memory update",
        mode: "acceptEdits",
      });
      const thread: Thread = { ...created, role: "dream", workspaceId };
      host.replace(thread);
      host.setStatus(thread.id, "running", "reading input/sessions");
      const model: ModelRef = input.model ?? { agent: "claude", model: "default" };
      const memory = memoryOf(workspaceId);
      const empty = currentOf(memory).files.size === 0;
      const id = dreamId();
      const plan =
        input.kind === "dream" && input.threadIds === undefined ? planOf(workspaceId) : undefined;
      if (plan !== undefined && plan.reports + plan.merges + plan.questions + plan.threads === 0) {
        throw new MockInvalidState(
          "Nothing new since the last memory update: no worker report, merge, answered question or finished thread.",
        );
      }
      const started = putDream({
        id,
        workspaceId,
        kind: input.kind,
        mode: input.mode ?? (input.kind === "dream" ? memoryUpdateModeOf(state.charter) : "review"),
        status: "running",
        inputs: {
          memoryVersion: empty ? "" : memory.current,
          threadIds: [...(input.threadIds ?? [])],
          agentSessions: [...(input.agentSessions ?? [])],
          ...(plan === undefined
            ? {}
            : {
                recent: {
                  throughReportSeq: plan.reports,
                  throughEventSeq: plan.merges,
                  throughAt: Date.now(),
                  sinceAt: plan.sinceAt,
                  reports: plan.reports,
                  merges: plan.merges,
                  questions: plan.questions,
                  threads: plan.threads,
                  estimatedTokens: plan.estimatedTokens,
                },
              }),
        },
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        model,
        threadId: thread.id,
        outputDir: `/mock/orchestration/${workspaceId}/dreams/${thread.id}`,
        createdAt: Date.now(),
      });
      failDreamSoon(host, thread, started, putDream);
      return started;
    },

    async listDreams(workspaceId: WorkspaceId): Promise<readonly Dream[]> {
      const state = requireWorkspace(workspaceId);
      const mode = memoryUpdateModeOf(state.charter);
      const was = modes.get(workspaceId);
      modes.set(workspaceId, mode);
      if (was !== undefined && was !== mode && mode === "auto") {
        const waiting = dreams.filter(
          (dream) =>
            dream.workspaceId === workspaceId &&
            dream.status === "completed" &&
            dream.mode === "review" &&
            dream.adoptedVersion === undefined &&
            dream.inputs.recent !== undefined,
        );
        for (const dream of waiting) {
          if (dream.threadId !== undefined) await host.closeThread(dream.threadId);
          outputs.delete(dream.id);
        }
        dreams = dreams.filter((dream) => !waiting.includes(dream));
      }
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
        throw new MockInvalidState("Only a running memory update can be cancelled.");
      }
      if (dream.threadId !== undefined) host.setStatus(dream.threadId, "idle");
      return putDream({ ...dream, status: "canceled", failure: "canceled", endedAt: Date.now() });
    },

    async adopt(id: DreamId, input: AdoptDreamInput = {}): Promise<Dream> {
      const dream = findDream(id);
      const output = outputs.get(id);
      if (dream.status !== "completed" || output === undefined) {
        throw new MockInvalidState("Only a completed memory update can be adopted.");
      }
      if (dream.adoptedVersion !== undefined) {
        throw new MockInvalidState(
          `This memory update was adopted already, as ${dream.adoptedVersion}.`,
        );
      }
      const memory = memoryOf(dream.workspaceId);
      if (input.basedOn !== undefined && input.basedOn !== memory.current) {
        throw new MockInvalidState(
          `Memory was adopted or restored since this review (it is version ${memory.current} now). Review the memory update again.`,
        );
      }
      if (input.outputDigest !== undefined && input.outputDigest !== output.digest) {
        throw new MockInvalidState(
          "The memory update's output was changed since this review. Review the memory update again.",
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
          `There is no finished merge of ${unmerged.map((file) => file.path).join(", ")} as memory and the memory update's output hold it now. Merge it again, or choose a side.`,
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
      const based = memory.current;
      memory.versions = [
        ...memory.versions,
        {
          version: next,
          adoptedAt: now,
          files,
          source: {
            dreamId: dream.id,
            mode: dream.mode,
            basedOn: based,
            ...(dream.summary === undefined ? {} : { summary: dream.summary }),
          },
        },
      ].slice(-VERSIONS_KEEP);
      memory.current = next;
      merges.delete(id);
      if (dream.inputs.recent !== undefined) {
        recent.set(dream.workspaceId, { reports: 0, merges: 0, questions: 0, threads: 0 });
        lastAdopted.set(dream.workspaceId, now);
      }
      return putDream({ ...dream, adoptedVersion: next });
    },

    async merge(id: DreamId, path: string): Promise<DreamMerge> {
      const dream = findDream(id);
      if (dream.adoptedVersion !== undefined) {
        throw new MockInvalidState(
          `That memory update was already adopted as version ${dream.adoptedVersion}.`,
        );
      }
      if (dream.status !== "completed") {
        throw new MockInvalidState("Only a completed memory update's conflicts can be merged.");
      }
      const file = (await this.review(id)).files.find((candidate) => candidate.path === path);
      if (file?.status !== "conflict") {
        throw new MockInvalidState(`${path} isn't a conflict of this memory update's review.`);
      }
      if (file.after === undefined || file.current === undefined) {
        throw new MockInvalidState(
          `One side removed ${path}, so there are not two versions to merge. Take the memory update's or keep memory's.`,
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

    async revert(id: DreamId): Promise<void> {
      const dream = findDream(id);
      const memory = memoryOf(dream.workspaceId);
      if (dream.adoptedVersion === undefined) {
        throw new MockInvalidState(
          "That memory update made no memory version, so there is nothing to revert.",
        );
      }
      if (memory.current !== dream.adoptedVersion) {
        throw new MockInvalidState(
          `Memory is at version ${memory.current} now, not the ${dream.adoptedVersion} this update made. Restore a version from History instead.`,
        );
      }
      memory.versions = [...memory.versions, revertedVersion(memory, dream)].slice(-VERSIONS_KEEP);
      memory.current = memory.versions.at(-1)!.version;
      putDream({ ...dream, revertedAt: Date.now() });
    },

    async discard(id: DreamId): Promise<void> {
      const dream = findDream(id);
      if (dream.status === "running" || dream.status === "pending") {
        throw new MockInvalidState("The memory update is still running: cancel it first.");
      }
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
      const autoId = dreamId();
      const autoSummary =
        "Filed the api-before-web merge order and the Redis port for queue tests (2 notes changed, 3 notes added)";
      memories.set(workspaceId, {
        versions: [
          { version: "0001", adoptedAt: now - 8 * day, files: first },
          {
            version: "0002",
            adoptedAt: now - 3 * day,
            files,
            source: { dreamId: autoId, mode: "auto", basedOn: "0001", summary: autoSummary },
          },
        ],
        current: "0002",
      });
      lastAdopted.set(workspaceId, now - 3 * day);
      const recentRead = (counts: MockRecent) => ({
        throughReportSeq: counts.reports,
        throughEventSeq: counts.merges,
        throughAt: now,
        sinceAt: now - 4 * day,
        ...counts,
        estimatedTokens:
          300 +
          (counts.reports + counts.merges + counts.questions + counts.threads) * TOKENS_PER_ITEM,
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
        "# Memory update report\n\n## Merged\n- Two entries about merge order in decisions.md said the same thing; kept one. Source: PR api#212.\n\n## Dropped\n- repos/docs-notes.md: a one-off debugging note from 2026-09-12 that no later session used.\n\n## New\n- conventions.md: branch names and who reviews what. Sources: mail-trigger, registry-paging.\n\n## Unresolved\n- Whether docs needs a preview deploy: left as Q3 in questions.md.\n";
      const conventions =
        "# Conventions\n\n- 2026-09-17 · Branches are feat/<slug>, the same in every repo of a feature. Source: mail-trigger.\n- 2026-09-20 · The repo's code owners review; the AI reviewer's approval is enough to merge. Source: registry-paging.\n";
      const finished = await spawn("Memory update");
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
          inputs: {
            memoryVersion: "0002",
            threadIds: [],
            agentSessions: [],
            recent: recentRead({ reports: 7, merges: 3, questions: 2, threads: 5 }),
          },
          model: { agent: "claude", model: "opus" },
          threadId: finished.id,
          usage: { tokens: { inputTokens: 412_000, outputTokens: 9_800 }, costUsd: 2.35 },
          createdAt: now - 5 * 60 * 60_000,
          endedAt: now - 5 * 60 * 60_000 + 11 * 60_000,
        },
        {
          ...base,
          id: autoId,
          kind: "dream",
          mode: "auto",
          status: "completed",
          adoptedVersion: "0002",
          summary: autoSummary,
          inputs: {
            memoryVersion: "0001",
            threadIds: [],
            agentSessions: [],
            recent: recentRead({ reports: 9, merges: 4, questions: 1, threads: 6 }),
          },
          model: { agent: "claude", model: "claude-sonnet-5-5" },
          usage: { tokens: { inputTokens: 31_000, outputTokens: 2_400 }, costUsd: 0.12 },
          createdAt: now - 3 * day - 3 * 60_000,
          endedAt: now - 3 * day,
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
