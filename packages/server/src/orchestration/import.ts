/**
 * What a history import can read: discovery and the preview built
 * from it. It only lists and reads; nothing here writes outside what it returns.
 *
 * Only supported hosts with `listSessions` are asked: Claude and Codex (both homes).
 * A host that can only list is named as left out rather than counted. An agent's history is keyed by the folder a session ran in, so every project
 * is asked for its root **and** each path of `git worktree list`. The preview reports what was
 * found and how it was looked for, never more: sessions of a worktree that has since been removed
 * show up only when the agent happens to list them from the repo root, which Claude does and
 * Codex, which matches the folder exactly, doesn't.
 */
import type { AgentHost } from "@gram/agents";
import {
  AgentKind,
  type AgentSessionSummary,
  type DreamAgentSession,
  type ImportPreview,
  type ImportSourcePreview,
  type Project,
} from "@gram/contracts";
import { realPathOrOwned, samePath, type Worktrees } from "@gram/git";
import * as Effect from "effect/Effect";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeCwdExact } from "./claude-project-path.ts";
import type { AgentHosts } from "../runtime/agent-hosts.ts";
import { DREAM_SEED_MAX_BYTES, DREAM_SEEDS_MAX } from "./dream-files.ts";

/** How many of each repo's newest sessions an import reads unless told otherwise. */
const IMPORT_PER_REPO = 30;
/**
 * What one session is guessed to cost to read, in tokens. No agent's session listing says how long
 * a session is, so this is a flat guess from rendered coding sessions (tens of KB each, capped at
 * 200,000 characters): enough for the preview's order of magnitude, and said to be a guess there.
 */
export const IMPORT_TOKENS_PER_SESSION = 12_000;

/** One past session an import would read. */
interface DiscoveredSession extends DreamAgentSession {
  readonly projectId: Project["id"];
  readonly title: string;
  /** Epoch ms. */
  readonly updatedAt: number;
}

/** One file of Claude Code's own memory for a folder of the workspace. */
interface DiscoveredSeed {
  /** The folder whose memory it is. */
  readonly cwd: string;
  /** The file's name inside that memory directory. */
  readonly name: string;
  readonly text: string;
}

/** What discovery found, before it is cut down to a preview or a dream's inputs. */
export interface ImportDiscovery {
  /** Readable sessions, newest first, at most `perRepo` per project. */
  readonly sessions: ReadonlyArray<DiscoveredSession>;
  readonly worktreesCovered: number;
  readonly worktreesTotal: number;
  readonly seeds: ReadonlyArray<DiscoveredSeed>;
  readonly notes: ReadonlyArray<string>;
}

/** What discovery needs from the server; narrow so a test can fake each part. */
export interface ImportDeps {
  readonly hosts: AgentHosts["Service"];
  /** Absent without the git runtime: only each project's root is asked for. */
  readonly worktrees?: Pick<Worktrees["Service"], "list"> | undefined;
  /** Claude Code's config directories; `$CLAUDE_CONFIG_DIR` and `~/.claude` unless given. */
  readonly claudeConfigDirs?: ReadonlyArray<string> | undefined;
}

export interface DiscoverInput {
  readonly projects: ReadonlyArray<Project>;
  readonly perRepo?: number | undefined;
  readonly includeMemory?: boolean | undefined;
}

const newestFirst = (a: DiscoveredSession, b: DiscoveredSession) =>
  b.updatedAt - a.updatedAt || a.agentSessionId.localeCompare(b.agentSessionId);

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const defaultConfigDirs = (): ReadonlyArray<string> => {
  const configured = process.env["CLAUDE_CONFIG_DIR"];
  return [
    ...(configured === undefined || configured === "" ? [] : [configured]),
    join(homedir(), ".claude"),
  ];
};

/**
 * The Markdown files of `<configDir>/projects/<encoded cwd>/memory/`, read-only. Nothing here is
 * trusted to be what it says: a symlink is skipped rather than followed, since the directory is
 * the user's and an import must not become a way to read an arbitrary file into a model's context.
 */
const readSeeds = (configDirs: ReadonlyArray<string>, cwd: string) =>
  Effect.promise(async (): Promise<ReadonlyArray<DiscoveredSeed>> => {
    const seeds: Array<DiscoveredSeed> = [];
    // Claude Code names the project directory after the real path, which on macOS is not the
    // `/tmp/...` or `/var/...` spelling a project may have been opened by.
    const real = await realPathOrOwned(cwd);
    const spellings = [...new Set([cwd, real])];
    for (const configDir of configDirs) {
      for (const spelling of spellings) {
        const dir = join(configDir, "projects", encodeCwdExact(spelling), "memory");
        const names = await readdir(dir).catch((): Array<string> => []);
        for (const name of names.toSorted()) {
          if (!name.toLowerCase().endsWith(".md")) continue;
          const path = join(dir, name);
          const stats = await lstat(path).catch(() => undefined);
          if (stats === undefined || !stats.isFile() || stats.size > DREAM_SEED_MAX_BYTES) continue;
          const text = await readFile(path, "utf8").catch(() => undefined);
          if (text === undefined || text.trim() === "") continue;
          if (!seeds.some((seed) => seed.name === name && seed.text === text)) {
            seeds.push({ cwd, name, text });
          }
        }
      }
    }
    return seeds;
  });

/**
 * Finds the past sessions of `projects` in every agent's own history, and with `includeMemory`
 * Claude Code's memory files for the same folders. Never fails: a host that is unavailable or a
 * listing that dies becomes a note, because a thin preview is an answer and an error is not.
 */
export const discoverHistory = (
  deps: ImportDeps,
  input: DiscoverInput,
): Effect.Effect<ImportDiscovery> =>
  Effect.gen(function* () {
    const perRepo = input.perRepo ?? IMPORT_PER_REPO;
    const notes: Array<string> = [];
    const hosts: Array<AgentHost> = [];
    const unreadable: Array<AgentHost> = [];
    for (const kind of AgentKind.literals) {
      const host = yield* deps.hosts.get(kind).pipe(Effect.orElseSucceed(() => undefined));
      if (host?.listSessions === undefined) continue;
      (host.readSession === undefined ? unreadable : hosts).push(host);
    }

    let worktreesCovered = 0;
    let worktreesTotal = 0;
    const sessions: Array<DiscoveredSession> = [];
    const unreadableFound = new Map<AgentKind, number>();
    const seeds: Array<DiscoveredSeed> = [];

    for (const project of input.projects) {
      const listed =
        deps.worktrees === undefined
          ? undefined
          : yield* deps.worktrees
              .list(project.root, { openCheckouts: [] })
              .pipe(Effect.orElseSucceed(() => undefined));
      // Every other checkout of the repo, the main one included when the project is itself a
      // worktree: history is keyed by folder, whichever of them the project was opened as.
      const worktrees = (listed?.worktrees ?? [])
        .map((worktree) => worktree.path)
        .filter((path) => !samePath(path, project.root));
      const folders = [project.root, ...worktrees];
      worktreesTotal += worktrees.length;
      if (listed === undefined && deps.worktrees !== undefined) {
        notes.push(
          `${project.name}: its worktrees couldn't be listed, so only the repo root was asked for.`,
        );
      }

      const found = new Map<string, DiscoveredSession>();
      const covered = new Set<string>();
      for (const host of [...hosts, ...unreadable]) {
        const readable = host.readSession !== undefined;
        for (const cwd of folders) {
          const summaries = yield* host.listSessions!({ cwd, limit: perRepo }).pipe(
            Effect.catch((error) => {
              notes.push(`${project.name}: ${host.kind} couldn't list ${cwd} (${error.message}).`);
              return Effect.succeed<ReadonlyArray<AgentSessionSummary>>([]);
            }),
          );
          if (cwd !== project.root) covered.add(cwd);
          for (const summary of summaries) {
            if (!readable) {
              unreadableFound.set(host.kind, (unreadableFound.get(host.kind) ?? 0) + 1);
              continue;
            }
            const key = `${host.kind}:${summary.agentSessionId}`;
            if (found.has(key)) continue;
            found.set(key, {
              projectId: project.id,
              agent: host.kind,
              cwd: summary.cwd ?? cwd,
              agentSessionId: summary.agentSessionId,
              title: summary.title,
              updatedAt: summary.updatedAt,
            });
          }
        }
      }
      if (hosts.length + unreadable.length > 0) worktreesCovered += covered.size;
      sessions.push(...[...found.values()].toSorted(newestFirst).slice(0, perRepo));

      if (input.includeMemory === true) {
        const configDirs = deps.claudeConfigDirs ?? defaultConfigDirs();
        for (const cwd of folders) seeds.push(...(yield* readSeeds(configDirs, cwd)));
      }
    }

    for (const [kind, count] of unreadableFound) {
      notes.push(
        `${plural(count, "session")} of ${kind} found but left out: Gram can list that agent's history, not read it yet.`,
      );
    }
    if (hosts.length === 0) {
      notes.push("No agent whose history can be read is available, so there is nothing to import.");
    }
    if (worktreesTotal > 0 || sessions.length > 0) {
      notes.push(
        "Sessions of worktrees that have been removed are counted only where the agent still lists them from a folder that exists: Claude does from the repo root, Codex doesn't. How many are missing can't be known.",
      );
    }
    if (seeds.length > DREAM_SEEDS_MAX) {
      notes.push(
        `${seeds.length} Claude Code memory files found; only the first ${DREAM_SEEDS_MAX} are read.`,
      );
    }
    return {
      sessions: sessions.toSorted(newestFirst),
      worktreesCovered,
      worktreesTotal,
      seeds: seeds.slice(0, DREAM_SEEDS_MAX),
      notes,
    };
  });

/** One row per project, agent and folder, in the order the projects were given, newest folder first. */
const previewSources = (
  projects: ReadonlyArray<Project>,
  sessions: ReadonlyArray<DiscoveredSession>,
): ReadonlyArray<ImportSourcePreview> => {
  const rows = new Map<string, Array<DiscoveredSession>>();
  for (const session of sessions) {
    const key = `${session.projectId}\n${session.agent}\n${session.cwd}`;
    rows.set(key, [...(rows.get(key) ?? []), session]);
  }
  const order = new Map(projects.map((project, index) => [project.id, index]));
  return [...rows.values()]
    .map((group): ImportSourcePreview => {
      const first = group[0]!;
      const times = group.map((session) => session.updatedAt);
      return {
        projectId: first.projectId,
        project: projects.find((project) => project.id === first.projectId)?.name ?? "",
        agent: first.agent,
        cwd: first.cwd,
        sessions: group.length,
        oldest: Math.min(...times),
        newest: Math.max(...times),
        estimatedTokens: group.length * IMPORT_TOKENS_PER_SESSION,
      };
    })
    .toSorted(
      (a, b) =>
        (order.get(a.projectId) ?? 0) - (order.get(b.projectId) ?? 0) ||
        (b.newest ?? 0) - (a.newest ?? 0) ||
        a.cwd.localeCompare(b.cwd),
    );
};

/** The preview of a discovery, with the counts only the store knows. */
export const importPreview = (input: {
  readonly projects: ReadonlyArray<Project>;
  readonly discovery: ImportDiscovery;
  readonly closedThreadsKept: number;
  readonly archivedThreads: number;
  readonly includeMemory: boolean;
  /** Whether the model a dream would run on is reached through the gateway. */
  readonly throughGateway: boolean;
}): ImportPreview => {
  const { discovery } = input;
  return {
    sources: previewSources(input.projects, discovery.sessions),
    worktreesCovered: discovery.worktreesCovered,
    worktreesTotal: discovery.worktreesTotal,
    closedThreadsKept: input.closedThreadsKept,
    archivedThreads: input.archivedThreads,
    ...(input.includeMemory ? { seedFiles: discovery.seeds.length } : {}),
    notes: [
      ...discovery.notes,
      ...(discovery.sessions.length === 0
        ? []
        : [
            `Token counts are a flat guess of ${IMPORT_TOKENS_PER_SESSION.toLocaleString("en-US")} per session: the agents' history doesn't say how long a session is.`,
          ]),
      input.throughGateway
        ? "The dream's model is reached through the LiteLLM gateway, so the redacted transcripts go through it."
        : "Transcripts are redacted, stay on this machine, and are read only by the model the dream runs on.",
    ],
  };
};
