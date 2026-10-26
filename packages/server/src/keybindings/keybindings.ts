import { unwatchFile, watch, watchFile, type Stats } from "node:fs";
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
 * How `watchKeybindings` notices changes. Windows polls the file's stat instead of watching the
 * folder: on Windows, a native directory `fs.watch` that is closed and whose folder is deleted soon
 * after aborts Node with 0xC0000409. That was reproduced in a separate process on windows-latest
 * (Node 24.20) with watch → change → stop → `rmSync`. Tests do exactly that, and a user deleting the
 * data folder could too. Polling holds no handle on the folder.
 */
export const keybindingsWatchMode = (platform: NodeJS.Platform): "watch" | "poll" =>
  platform === "win32" ? "poll" : "watch";

export interface WatchKeybindingsOptions {
  readonly debounceMs?: number;
  /** The stat interval when polling. */
  readonly pollMs?: number;
  readonly platform?: NodeJS.Platform;
}

/**
 * Calls `onChange` (debounced) whenever `keybindings.json` changes in `dataDir`. Returns a stop
 * function; stopping twice is harmless.
 */
export function watchKeybindings(
  dataDir: string,
  onChange: () => void,
  options: WatchKeybindingsOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 150;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const changed = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  let close: () => void;
  if (keybindingsWatchMode(options.platform ?? process.platform) === "poll") {
    const path = join(dataDir, KEYBINDINGS_FILE);
    const listener = (current: Stats, previous: Stats) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) changed();
    };
    watchFile(path, { interval: options.pollMs ?? 1000, persistent: false }, listener);
    close = () => unwatchFile(path, listener);
  } else {
    const watcher = watch(dataDir, (_event, filename) => {
      if (filename !== null && filename.toString() !== KEYBINDINGS_FILE) return;
      changed();
    });
    // A watch that dies (e.g. the folder is removed) just stops hot-reloading.
    watcher.on("error", () => watcher.close());
    close = () => watcher.close();
  }

  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    close();
  };
}
