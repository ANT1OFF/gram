// The mock's workspace Files: a few synthetic outputs for each thread of a workspace (browser
// evidence, a stored tool image, a written document, a sent report), made from the world's threads
// when asked, so any scenario with workers shows some. The pictures are drawn SVG stand-ins served
// through the same `fsImage` / `readAttachment` a real screenshot is, and only for the thread that
// "made" them; nothing here is a real capture.

import {
  checkoutRoots,
  effectiveCheckout,
  OUTPUTS_PAGE,
  OUTPUTS_PAGE_MAX,
  outputKindOf,
  outputMediaType,
  type FileImage,
  type OutputKind,
  type OutputSource,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceOutput,
  type WorkspaceOutputsPage,
} from "@gram/contracts";

import type { MockWorld } from "./mock-world";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ATTACHMENTS = "/Users/dev/Library/Application Support/gram-state/attachments";

interface Planned {
  readonly path: string;
  readonly source: OutputSource;
  /** Before the thread's last activity. */
  readonly ago: number;
  readonly size: number;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "work";

/** What `thread` "made", the `index`th of its workspace: workers more, the orchestrator a plan. */
const planFor = (thread: Thread, index: number): Planned[] => {
  const root = effectiveCheckout(thread).path;
  const feature = thread.spawnedBy?.feature ?? slug(thread.title);
  // Spread over the last few days, so the view groups by day.
  const base = index * 9 * HOUR;
  if (thread.role === "orchestrator") {
    return [
      { path: `${root}/notes/plan.md`, source: "written", ago: base + 40 * MINUTE, size: 2_310 },
    ];
  }
  const evidence = `${root}/docs/verification/${feature}`;
  const planned: Planned[] = [
    { path: `${evidence}/after.png`, source: "evidence", ago: base + 4 * MINUTE, size: 182_400 },
    { path: `${evidence}/before.png`, source: "evidence", ago: base + 9 * MINUTE, size: 176_950 },
    {
      path: `${ATTACHMENTS}/${thread.id}/tool-${(index * 7919).toString(16).padStart(8, "0")}.png`,
      source: "toolImage",
      ago: base + 21 * MINUTE,
      size: 96_120,
    },
    {
      path: `${root}/docs/verification/${feature}.md`,
      source: "written",
      ago: base + 2 * MINUTE,
      size: 3_870,
    },
  ];
  if (index % 2 === 1) {
    planned.push({
      path: `${evidence}/flow.gif`,
      source: "evidence",
      ago: base + 6 * MINUTE,
      size: 1_204_000,
    });
  }
  if (index % 3 === 0) {
    planned.push({
      path: `${root}/out/diagram.svg`,
      source: "written",
      ago: base + 30 * MINUTE,
      size: 8_400,
    });
    planned.push({
      path: `${root}/out/report.pdf`,
      source: "sent",
      ago: base + 12 * MINUTE,
      size: 412_000,
    });
    // Sent from outside its checkout: listed and revealed, but no reader of the thread opens it.
    planned.push({
      path: `/Users/dev/Downloads/${feature}-summary.txt`,
      source: "sent",
      ago: base + 14 * MINUTE,
      size: 1_240,
    });
  }
  return planned;
};

/** The threads of `workspaceId`, orchestrator first, then workers by title. */
const workspaceThreads = (world: MockWorld, workspaceId: WorkspaceId): Thread[] =>
  world
    .threads()
    .map((summary) => summary.thread)
    .filter((thread) => thread.workspaceId === workspaceId && thread.role !== "dream")
    .toSorted(
      (a, b) =>
        Number(b.role === "orchestrator") - Number(a.role === "orchestrator") ||
        a.title.localeCompare(b.title),
    );

/** Every synthetic output of `workspaceId`, newest first. */
export function mockOutputs(world: MockWorld, workspaceId: WorkspaceId): WorkspaceOutput[] {
  const now = Date.now();
  const outputs: WorkspaceOutput[] = [];
  workspaceThreads(world, workspaceId).forEach((thread, index) => {
    for (const planned of planFor(thread, index)) {
      outputs.push({
        id: `${thread.id}:${planned.path}`,
        threadId: thread.id,
        threadTitle: thread.title,
        orchestrator: thread.role === "orchestrator",
        ...(thread.spawnedBy === undefined ? {} : { feature: thread.spawnedBy.feature }),
        path: planned.path,
        kind: outputKindOf(planned.path, planned.source),
        source: planned.source,
        mediaType: outputMediaType(planned.path),
        size: planned.size,
        at: Math.min(thread.lastActivityAt, now) - planned.ago,
      });
    }
  });
  return outputs.toSorted((a, b) => b.at - a.at || b.id.localeCompare(a.id));
}

/** `listOutputs` over `mockOutputs`, paged as the server pages. */
export function pageMockOutputs(
  world: MockWorld,
  workspaceId: WorkspaceId,
  options: { kind?: OutputKind; cursor?: string; limit?: number } = {},
): WorkspaceOutputsPage {
  const all = mockOutputs(world, workspaceId).filter(
    (output) => options.kind === undefined || output.kind === options.kind,
  );
  const start = options.cursor === undefined ? 0 : Number(options.cursor);
  if (!Number.isInteger(start) || start < 0) {
    throw Object.assign(new Error("That isn't a page of this list"), { _tag: "InvalidState" });
  }
  const limit = Math.min(options.limit ?? OUTPUTS_PAGE, OUTPUTS_PAGE_MAX);
  const end = start + limit;
  return {
    outputs: all.slice(start, end),
    ...(end < all.length ? { next: String(end) } : {}),
  };
}

const hue = (text: string) => {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
};

/** A drawn page: a title bar, a sidebar and a few blocks, tinted by `path`. */
const pageSvg = (path: string, recording: boolean) => {
  const h = hue(path);
  const accent = `hsl(${h} 62% 56%)`;
  const soft = `hsl(${h} 40% 92%)`;
  const play = recording
    ? `<circle cx="160" cy="100" r="22" fill="rgb(0 0 0 / 0.55)"/><path d="M153 89 L172 100 L153 111 Z" fill="#fff"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#f7f7f8"/><rect width="320" height="18" fill="#e6e6e9"/><circle cx="10" cy="9" r="3" fill="#ff5f57"/><circle cx="20" cy="9" r="3" fill="#febc2e"/><circle cx="30" cy="9" r="3" fill="#28c840"/><rect x="0" y="18" width="70" height="182" fill="${soft}"/><rect x="10" y="30" width="48" height="6" rx="3" fill="${accent}"/><rect x="10" y="44" width="40" height="5" rx="2.5" fill="#c9c9cf"/><rect x="10" y="56" width="44" height="5" rx="2.5" fill="#c9c9cf"/><rect x="86" y="32" width="150" height="10" rx="3" fill="#2b2b30"/><rect x="86" y="52" width="216" height="56" rx="6" fill="#fff" stroke="#e1e1e5"/><rect x="96" y="64" width="120" height="6" rx="3" fill="#c9c9cf"/><rect x="96" y="78" width="160" height="6" rx="3" fill="#dcdce1"/><rect x="96" y="92" width="64" height="8" rx="4" fill="${accent}"/><rect x="86" y="120" width="104" height="64" rx="6" fill="#fff" stroke="#e1e1e5"/><rect x="198" y="120" width="104" height="64" rx="6" fill="#fff" stroke="#e1e1e5"/><rect x="96" y="132" width="60" height="6" rx="3" fill="${accent}" opacity="0.6"/><rect x="208" y="132" width="70" height="6" rx="3" fill="#c9c9cf"/>${play}</svg>`;
};

/** A drawn diagram, for an image that isn't a page. */
const diagramSvg = (path: string) => {
  const h = hue(path);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="hsl(${h} 30% 96%)"/><g fill="none" stroke="hsl(${h} 45% 45%)" stroke-width="2"><rect x="30" y="80" width="70" height="40" rx="8"/><rect x="125" y="40" width="70" height="40" rx="8"/><rect x="125" y="120" width="70" height="40" rx="8"/><rect x="220" y="80" width="70" height="40" rx="8"/><path d="M100 100 L125 60 M100 100 L125 140 M195 60 L220 100 M195 140 L220 100"/></g></svg>`;
};

/** The drawings are ASCII, so `btoa` takes them as they are. */
const toBase64 = (text: string) => btoa(text);

/** The server reader a request comes through: `fs.image`, `attachment.read` or `fs.file`. */
export type MockOutputReader = "image" | "attachment" | "file";

/**
 * The synthetic output `threadId` made at `path`, when `reader` would serve it on the server:
 * `attachment.read` only what a message part names (a tool's image, a sent file), and `fs.image` /
 * `fs.file` what is in the thread's checkouts or a file it wrote.
 */
const servedOutput = (
  world: MockWorld,
  threadId: ThreadId | undefined,
  path: string,
  reader: MockOutputReader,
): { thread: Thread; output: WorkspaceOutput } | undefined => {
  if (threadId === undefined) return undefined;
  const thread = world.threads().find((summary) => summary.thread.id === threadId)?.thread;
  if (thread?.workspaceId === undefined) return undefined;
  const output = mockOutputs(world, thread.workspaceId).find(
    (each) => each.threadId === threadId && each.path === path,
  );
  if (output === undefined) return undefined;
  if (reader === "attachment") {
    return output.source === "toolImage" || output.source === "sent"
      ? { thread, output }
      : undefined;
  }
  const inside = checkoutRoots(thread).some((root) => path.startsWith(`${root}/`));
  return inside || output.source === "written" ? { thread, output } : undefined;
};

/**
 * The picture `threadId` "made" at `path`, as `reader` serves it; `undefined` for any other path or
 * thread, or one that reader would refuse, which then goes through the mock's ordinary checks.
 */
export function mockOutputImage(
  world: MockWorld,
  threadId: ThreadId | undefined,
  path: string,
  reader: Exclude<MockOutputReader, "file">,
): FileImage | undefined {
  const output = servedOutput(world, threadId, path, reader)?.output;
  if (output === undefined || !output.mediaType.startsWith("image/")) return undefined;
  const svg =
    output.kind === "image" ? diagramSvg(path) : pageSvg(path, output.kind === "recording");
  return {
    path,
    mediaType: "image/svg+xml",
    size: output.size,
    tooLarge: false,
    base64: toBase64(svg),
  };
}

/** The text of a document `threadId` "wrote" at `path`, for the Files panel. */
export function mockOutputText(
  world: MockWorld,
  threadId: ThreadId | undefined,
  path: string,
): string | undefined {
  const served = servedOutput(world, threadId, path, "file");
  if (served?.output.mediaType !== "text/markdown") return undefined;
  const { thread } = served;
  return `# ${thread.spawnedBy?.feature ?? thread.title}\n\nVerified against the mock: before and after screenshots, a recording of the flow, and the checks that ran.\n`;
}
