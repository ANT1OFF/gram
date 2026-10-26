import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  COLOR_TOKENS,
  buildTokens,
  parseRules,
  propsFor,
} from "../../.agents/skills/mock-build/scripts/mock-tokens.mjs";
import {
  approve,
  isSlug,
  newRecord,
  nextVersion,
  withStatus,
} from "../../.agents/skills/mock-build/scripts/new-mock.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const skill = join(root, ".agents/skills/mock-build");
const read = (path) => readFileSync(join(root, path), "utf8");

// Set by a page's tweaks, a board's size or a grid's own style, never by tokens.css.
const optional = (name) => name.startsWith("tweak-") || name.startsWith("board-") || name === "min";

const palette = (extra = "") =>
  COLOR_TOKENS.map((token) => `--${token}: #${token.length.toString(16).padStart(6, "0")};`).join(
    "\n",
  ) + extra;

describe("mock tokens", () => {
  it("keeps the workspace's tokens.css in step with Gram's theme", () => {
    const config = JSON.parse(read("docs/design/mocks/tokens.config.json"));
    const css = read("apps/web/src/styles/generated/themes.css");
    const expected = buildTokens(config, css, "../../../apps/web/src/styles/generated/themes.css");
    // Stale after a theme change: run `bun run mocks:tokens`.
    expect(read("docs/design/mocks/tokens.css")).toBe(expected);
  });

  it("reads a selector's properties from every rule that lists it, later ones winning", () => {
    const rules = parseRules(
      `:root, [data-look="glass"] { --radius-sm: 6px; } /* --x: no */ :root { --radius-sm: 5px; }`,
    );
    expect(propsFor(rules, ":root").get("radius-sm")).toBe("5px");
    expect(propsFor(rules, '[data-look="glass"]').get("radius-sm")).toBe("6px");
    expect(propsFor(rules, ":root").has("x")).toBe(false);
  });

  it("resolves var() through the base and maps tokens a theme names differently", () => {
    const css = `:root { --brand: #123456; --radius-md: 7px; }
      .light { ${palette("--primary: var(--brand);")} }`;
    const out = buildTokens(
      { base: ":root", light: ".light", map: { accent: "primary" } },
      css,
      "theme.css",
    );
    expect(out).toContain("--accent: #123456;");
    expect(out).toContain("--radius-md: 7px;");
    expect(out).not.toContain("prefers-color-scheme");
  });

  it("names every missing token instead of writing a half palette", () => {
    const css = `.light { --fg: #000; }`;
    expect(() => buildTokens({ light: ".light" }, css, "theme.css")).toThrow(/--surface-1.*map/);
  });

  it("ships a fallback with every token the kit uses, light and dark", () => {
    const fallback = readFileSync(join(skill, "kit/tokens.css"), "utf8");
    const kit = readFileSync(join(skill, "kit/kit.css"), "utf8");
    const used = new Set([...kit.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]));
    const derived = new Set([...kit.matchAll(/^\s*--([\w-]+):/gm)].map((m) => m[1]));
    const supplied = new Set(propsFor(parseRules(fallback), ":root").keys());
    const missing = [...used].filter((n) => !supplied.has(n) && !derived.has(n) && !optional(n));
    // Radii fall back inside kit.css, and fonts are set by every tokens.css.
    expect(missing.filter((n) => !n.startsWith("radius-"))).toEqual([]);
    expect(propsFor(parseRules(fallback), ':root[data-theme="dark"]').size).toBe(
      COLOR_TOKENS.length,
    );
  });

  it("never names a colour of its own in the kit or the templates", () => {
    const files = [
      join(skill, "kit/kit.css"),
      ...readdirSync(join(skill, "templates")).map((f) => join(skill, "templates", f)),
    ];
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
    }
  });
});

describe("templates", () => {
  const icons = new Set(
    [...readFileSync(join(skill, "kit/kit.js"), "utf8").matchAll(/^ {4}([a-z]+):/gm)].map(
      (m) => m[1],
    ),
  );
  const templates = readdirSync(join(skill, "templates"));

  it("has the five the scaffold offers", () => {
    expect(templates.toSorted()).toEqual(
      [
        "app-screen.html",
        "components.html",
        "flow.html",
        "landing.html",
        "options.html",
      ].toSorted(),
    );
  });

  for (const name of templates) {
    it(`${name} keeps the page contract`, () => {
      const html = readFileSync(join(skill, "templates", name), "utf8");
      const links = [...html.matchAll(/(?:href|src)="(kit\/[^"]+)"/g)].map((m) => m[1]);
      expect(links).toEqual(["kit/tokens.css", "kit/kit.css", "kit/kit.js"]);
      expect(html).toMatch(/<body class="mock">\s*<main class="mock-canvas">/);
      expect(html).not.toMatch(/<script[^>]+src="https?:/);
      expect(html).toContain('name="viewport"');
      for (const [, icon] of html.matchAll(/data-icon="([a-z]+)"/g)) expect(icons).toContain(icon);
      for (const button of html.match(/<button\b[^>]*>/g) ?? []) expect(button).toContain("type=");
      for (const board of html.match(/<section class="board"[^>]*>/g) ?? []) {
        expect(board).toMatch(/data-name="[^"]+"/);
        expect(board).toMatch(/data-size="(?:fill|\d+x\d+)"/);
      }
      const states = [...html.matchAll(/data-states="([^"]+)"/g)].flatMap((m) => m[1].split(","));
      for (const [, when] of html.matchAll(/data-when="([^"]+)"/g)) {
        for (const state of when.split(/[\s,]+/)) expect(states).toContain(state);
      }
    });
  }
});

describe("mock.json", () => {
  const record = newRecord({ slug: "files", title: "Files", template: "flow", date: "2026-10-16" });

  it("starts a draft at v1", () => {
    expect(record).toMatchObject({ status: "draft", current: 1, approved: null });
    expect(record.versions).toEqual([{ n: 1, file: "v1.html", created: "2026-10-16" }]);
  });

  it("adds versions after the highest, back to draft", () => {
    const reviewed = withStatus(record, "in-review");
    const next = nextVersion(reviewed, "2026-10-17");
    expect(next.current).toBe(2);
    expect(next.status).toBe("draft");
    expect(next.versions.at(-1)).toEqual({ n: 2, file: "v2.html", created: "2026-10-17" });
  });

  it("approves only a version it has", () => {
    expect(approve(record, 1)).toMatchObject({ status: "approved", approved: 1 });
    expect(() => approve(record, 3)).toThrow(/No version 3/);
    expect(() => withStatus(record, "done")).toThrow(/draft, in-review, approved/);
  });

  it("takes lowercase dashed slugs only", () => {
    expect(isSlug("workspace-files")).toBe(true);
    for (const bad of ["Files", "../x", "a--b", "-a", ""]) expect(isSlug(bad)).toBe(false);
  });
});

describe("new-mock.mjs", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const run = (...args) =>
    execFileSync(process.execPath, [join(skill, "scripts/new-mock.mjs"), ...args, "--root", dir], {
      encoding: "utf8",
    });

  it("scaffolds the kit and the record but leaves the page to the Write tool", () => {
    dir = mkdtempSync(join(tmpdir(), "mocks-"));
    writeFileSync(join(dir, "tokens.css"), "/* workspace tokens */\n");
    const out = run("files", "--title", "Workspace files", "--template", "options");
    expect(out).toContain("templates/options.html");
    const folder = join(dir, "files");
    expect(readFileSync(join(folder, "kit/tokens.css"), "utf8")).toBe("/* workspace tokens */\n");
    expect(readFileSync(join(folder, "kit/kit.js"), "utf8")).toBe(
      readFileSync(join(skill, "kit/kit.js"), "utf8"),
    );
    for (const file of ["mock.json", "brief.md", "decisions.md"]) {
      expect(existsSync(join(folder, file))).toBe(true);
    }
    expect(existsSync(join(folder, "v1.html"))).toBe(false);
    expect(JSON.parse(readFileSync(join(folder, "mock.json"), "utf8"))).toMatchObject({
      title: "Workspace files",
      template: "options",
    });

    run("files", "--next");
    run("files", "--approve", "2");
    expect(JSON.parse(readFileSync(join(folder, "mock.json"), "utf8"))).toMatchObject({
      current: 2,
      status: "approved",
      approved: 2,
    });
  });

  it("uses the kit's fallback tokens in a workspace without its own", () => {
    dir = mkdtempSync(join(tmpdir(), "mocks-"));
    run("plain");
    expect(readFileSync(join(dir, "plain/kit/tokens.css"), "utf8")).toBe(
      readFileSync(join(skill, "kit/tokens.css"), "utf8"),
    );
  });
});
