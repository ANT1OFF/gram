import { statSync, watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeybindingOverrides, KeybindingsState } from "@gram/contracts";

export const KEYBINDINGS_FILE = "keybindings.json";
export const KEYBINDINGS_SCHEMA_FILE = "keybindings.schema.json";

/** The chords the web registry understands: `mod`, `alt` and `shift`, then one key. */
const KEYS_PATTERN = "^((mod|ctrl|alt|shift)\\+)*[^+\\s]+$";
const KEYS = new RegExp(KEYS_PATTERN, "i");

const KEYBINDINGS_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Gram keybindings",
  type: "object",
  properties: {
    $schema: { type: "string" },
    bindings: {
      type: "object",
      description:
        'Shortcut id → keys, e.g. "mod+shift+k" (mod is ⌘ on macOS, Ctrl elsewhere), or null to turn the shortcut off. Settings → Keyboard lists the ids.',
      additionalProperties: {
        anyOf: [{ type: "string", pattern: KEYS_PATTERN }, { type: "null" }],
      },
    },
  },
  additionalProperties: false,
} as const;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The overrides in a keybindings file, and why anything in it was ignored. */
export function parseKeybindings(text: string): {
  bindings: KeybindingOverrides;
  problems: string[];
} {
  if (text.trim() === "") return { bindings: {}, problems: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { bindings: {}, problems: [`keybindings.json isn't valid JSON: ${message(error)}`] };
  }
  const raw = typeof data === "object" && data !== null ? Reflect.get(data, "bindings") : undefined;
  if (raw === undefined) return { bindings: {}, problems: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { bindings: {}, problems: ['"bindings" must map shortcut ids to keys'] };
  }
  const bindings: Record<string, string | null> = {};
  const problems: string[] = [];
  for (const [id, value] of Object.entries(raw)) {
    if (value === null) bindings[id] = null;
    else if (typeof value === "string" && KEYS.test(value.trim())) {
      bindings[id] = value.trim().toLowerCase();
    } else {
      problems.push(
        `"${id}": ${JSON.stringify(value)} isn't a key combination like "mod+shift+k", so it's ignored`,
      );
    }
  }
  return { bindings, problems };
}

const formatKeybindingsFile = (bindings: KeybindingOverrides): string =>
  `${JSON.stringify({ $schema: `./${KEYBINDINGS_SCHEMA_FILE}`, bindings }, null, 2)}\n`;

/** Writes the schema beside the file so editors validate and complete it. */
const writeSchema = async (dataDir: string) => {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, KEYBINDINGS_SCHEMA_FILE),
    `${JSON.stringify(KEYBINDINGS_SCHEMA, null, 2)}\n`,
  );
};

/** Reads `keybindings.json` from `dataDir`; a missing file means no overrides. Never rejects. */
export async function readKeybindings(dataDir: string): Promise<KeybindingsState> {
  const path = join(dataDir, KEYBINDINGS_FILE);
  const problems: string[] = [];
  await writeSchema(dataDir).catch((error: unknown) =>
    problems.push(`Couldn't write ${KEYBINDINGS_SCHEMA_FILE}: ${message(error)}`),
  );
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      problems.push(`Couldn't read keybindings.json: ${message(error)}`);
    }
  }
  const parsed = parseKeybindings(text);
  return { path, bindings: parsed.bindings, problems: [...problems, ...parsed.problems] };
}

/** Replaces the overrides, rewriting the file with its `$schema` reference. */
export async function writeKeybindings(
  dataDir: string,
  bindings: KeybindingOverrides,
): Promise<KeybindingsState> {
  await writeSchema(dataDir);
  const path = join(dataDir, KEYBINDINGS_FILE);
  const text = formatKeybindingsFile(bindings);
  await writeFile(path, text);
  return { path, ...parseKeybindings(text) };
}

/**
 * Watch one configuration file with stat polling on macOS and Windows. macOS FSEvents can lose
 * its only change; native directory-watch setup and teardown are also synchronous.
 * Windows directory watches can abort Node if closed just before their folder is deleted
 * (0xC0000409, reproduced on Node 24.20). Polling holds no directory handle on either platform.
 */
export const keybindingsWatchMode = (platform: NodeJS.Platform): "watch" | "poll" =>
  platform === "win32" || platform === "darwin" ? "poll" : "watch";

export interface WatchKeybindingsOptions {
  readonly debounceMs?: number;
  /** The stat interval when polling. */
  readonly pollMs?: number;
  readonly platform?: NodeJS.Platform;
  /** Told when the folder can't be watched and the file is polled instead. */
  readonly onWatchFailed?: (error: unknown) => void;
}

/**
 * Calls `onChange` (debounced) whenever `keybindings.json` changes in `dataDir`. Returns a stop
 * function; stopping twice is harmless. A single stat baseline covers creation, replacement,
 * edits and deletion, without replaying unchanged events.
 */
export function watchKeybindings(
  dataDir: string,
  onChange: () => void,
  options: WatchKeybindingsOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 150;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const path = join(dataDir, KEYBINDINGS_FILE);
  const stamp = () => {
    try {
      const stat = statSync(path);
      return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    } catch {
      return undefined;
    }
  };
  // Capture before returning, including a missing file. An asynchronous first stat can absorb
  // the first write as its baseline when the native event for that write is lost.
  let previous = stamp();
  const changed = () => {
    if (stopped) return;
    const current = stamp();
    if (current === previous) return;
    previous = current;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  const startPolling = () => {
    if (poll === undefined) poll = setInterval(changed, options.pollMs ?? 1000);
    poll.unref();
  };

  let close: (() => void) | undefined;
  const platform = options.platform ?? process.platform;
  if (keybindingsWatchMode(platform) === "poll") {
    startPolling();
  } else {
    try {
      const watcher = watch(dataDir, (_event, filename) => {
        if (filename !== null && filename.toString() !== KEYBINDINGS_FILE) return;
        changed();
      });
      watcher.on("error", (error) => {
        watcher.close();
        if (stopped) return;
        options.onWatchFailed?.(error);
        startPolling();
      });
      close = () => watcher.close();
    } catch (error) {
      // Linux's inotify limit (ENOSPC/EMFILE) throws here; polling the file needs no watch.
      options.onWatchFailed?.(error);
      startPolling();
    }
  }

  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearInterval(poll);
    close?.();
  };
}
