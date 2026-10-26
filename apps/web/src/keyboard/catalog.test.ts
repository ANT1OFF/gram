import { describe, expect, it } from "vitest";

import { SHORTCUT_CATALOG } from "./catalog";

const sources = import.meta.glob<string>(["../**/*.ts", "../**/*.tsx", "!../**/*.test.*"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** `id` / `keys` string literals as registered through `useShortcut` or `registerShortcut`. */
function registeredLiterals(): { file: string; id: string; keys: string }[] {
  const found: { file: string; id: string; keys: string }[] = [];
  for (const [file, text] of Object.entries(sources)) {
    // Source text keeps string escapes (`"mod+\\"`); unescape to compare with the runtime value.
    for (const match of text.matchAll(/id: "([\w.-]+)",\s*keys: "([^"]+)"/g)) {
      found.push({ file, id: match[1]!, keys: match[2]!.replaceAll("\\\\", "\\") });
    }
    // Composer pickers pass their shortcut as props.
    for (const match of text.matchAll(/shortcutId="([\w.-]+)"\s+keys="([^"]+)"/g)) {
      found.push({ file, id: match[1]!, keys: match[2]! });
    }
  }
  return found;
}

describe("SHORTCUT_CATALOG", () => {
  it("lists every literal shortcut registration with its default keys", () => {
    const literals = registeredLiterals();
    expect(literals.length).toBeGreaterThan(20);
    for (const { file, id, keys } of literals) {
      const definition = SHORTCUT_CATALOG.find((d) => d.id === id);
      expect(definition, `${id} in ${file}`).toBeDefined();
      expect(definition?.keys, `${id} in ${file}`).toBe(keys);
    }
  });

  it("has unique ids", () => {
    const ids = SHORTCUT_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
