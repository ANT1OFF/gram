import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compare, scan } from "./check.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tokens = (source, file) => scan(source, file).map((v) => `${v.rule} ${v.token}`);

describe("design-token drift check", () => {
  it("flags text sizes outside the type scale", () => {
    expect(
      tokens(`cn("text-xs text-sm", "hover:text-[13px]", 'text-[0.8rem]/5 sm:text-2xl')`),
    ).toEqual([
      "text-size text-xs",
      "text-size text-sm",
      "text-size text-[13px]",
      "text-size text-[0.8rem]",
      "text-size text-2xl",
    ]);
  });

  it("passes the type scale and text colours", () => {
    expect(
      tokens(
        `"text-caption text-meta text-body text-body-strong text-reading text-title text-heading text-muted-foreground text-xs-foo text-(--section-count)"`,
      ),
    ).toEqual([]);
  });

  it("flags raw arbitrary spacing but not values built from tokens", () => {
    expect(
      tokens(
        `"p-[7px] -mt-[3px] gap-x-[0.5rem] pl-[max(--spacing(2),var(--inset))] mt-[calc((1lh-0.5rem)/2)] pt-[18vh] p-2 gap-section"`,
      ),
    ).toEqual(["spacing p-[7px]", "spacing -mt-[3px]", "spacing gap-x-[0.5rem]"]);
  });

  it("flags raw radii, Tailwind's literal rounded and its larger steps", () => {
    expect(
      tokens(
        `"rounded rounded-t rounded-[6px] rounded-tl-[2px] rounded-2xl rounded-2xs rounded-sm rounded-full rounded-[inherit] rounded-[min(var(--radius-md),10px)]"`,
      ),
    ).toEqual([
      "radius rounded",
      "radius rounded-t",
      "radius rounded-[6px]",
      "radius rounded-tl-[2px]",
      "radius rounded-2xl",
    ]);
  });

  it("flags Tailwind's shadows and raw shadow colours, not elevations", () => {
    expect(
      tokens(
        `"shadow shadow-md shadow-[0_1px_2px_rgb(0_0_0/0.1)] shadow-raised shadow-overlay shadow-none shadow-[inset_3px_0_0_var(--label-tint)] drop-shadow-sm"`,
      ),
    ).toEqual(["shadow shadow", "shadow shadow-md", "shadow shadow-[0_1px_2px_rgb(0_0_0/0.1)]"]);
  });

  it("flags colours that skip the palette", () => {
    expect(
      tokens(
        `const c = "#7aa2f7"; cn("bg-[#fff] text-[rgb(1_2_3)] bg-black/75 text-white border-red-500 bg-[color-mix(in_srgb,var(--fg)_5%,transparent)] bg-accent")`,
      ),
    ).toEqual([
      "color #7aa2f7",
      "color bg-[#fff]",
      "color text-[rgb(1_2_3)]",
      "color bg-black",
      "color text-white",
      "color border-red-500",
    ]);
  });

  it("ignores comments, though a bare word in prose can still match", () => {
    expect(
      tokens(
        `// was text-xs\n/* rounded corners */\nconst url = "https://x.test/a"; "Values are rounded to"`,
      ),
    ).toEqual(["radius rounded"]);
  });

  it("only flags hex in stylesheets, and not a mask layer's", () => {
    expect(
      tokens(`a { color: #fff; mask: linear-gradient(#fff 0 0); } #root { }`, "x.css"),
    ).toEqual(["color #fff"]);
  });

  it("reports what goes past the allowlist and what can come off it", () => {
    const byFile = {
      "a.tsx": [
        { rule: "text-size", token: "text-xs", line: 1 },
        { rule: "text-size", token: "text-xs", line: 2 },
      ],
    };
    expect(compare(byFile, { "a.tsx": { "text-size text-xs": 2 } })).toEqual({
      added: [],
      stale: [],
    });
    expect(compare(byFile, { "a.tsx": { "text-size text-xs": 1 } }).added).toHaveLength(2);
    expect(compare({}, { "a.tsx": { "text-size text-xs": 1 } }).stale).toEqual([
      { file: "a.tsx", key: "text-size text-xs", n: 0, limit: 1 },
    ]);
  });

  it("keeps the allowlist sorted and in a known mode", () => {
    const list = JSON.parse(readFileSync(join(root, "tools/design-tokens/allowlist.json"), "utf8"));
    expect(["warn", "error"]).toContain(list.mode);
    expect(Object.keys(list.files)).toEqual(Object.keys(list.files).toSorted());
  });
});
