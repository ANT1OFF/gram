import { describe, expect, it } from "@effect/vitest";
import { AppToolError, type GramUIMessageChunk, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { bindAppTools } from "./registry.ts";
import { showWidgetTool, WIDGET_MAX_LENGTH, widgetProblem } from "./widget-tool.ts";

const THREAD = "t-widget" as ThreadId;

const setup = () => {
  const chunks: Array<GramUIMessageChunk> = [];
  const [tool] = bindAppTools(
    [
      showWidgetTool({
        emitChunk: (_threadId, chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
            return "m-1" as never;
          }),
      }),
    ],
    THREAD,
  );
  return { chunks, tool: tool! };
};

describe("show_widget", () => {
  it.effect("puts the drawing on the reply as a widget part", () =>
    Effect.gen(function* () {
      const { chunks, tool } = setup();
      const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
      const result = (yield* tool.run({ title: " Latency ", svg })) as { widgetId: string };
      expect(chunks).toEqual([
        {
          type: "data-widget",
          id: result.widgetId,
          data: { id: result.widgetId, title: "Latency", svg },
        },
      ]);
    }),
  );

  it.effect("refuses anything that isn't one SVG document, and shows nothing", () =>
    Effect.gen(function* () {
      const { chunks, tool } = setup();
      for (const svg of ["<div>hi</div>", "<svg><rect/>", "```svg\n<svg></svg>\n```"]) {
        expect(yield* Effect.flip(tool.run({ title: "x", svg }))).toBeInstanceOf(AppToolError);
      }
      expect(chunks).toEqual([]);
    }),
  );

  it.effect("refuses a blank title", () =>
    Effect.gen(function* () {
      const { chunks, tool } = setup();
      const refused = yield* Effect.flip(tool.run({ title: "   ", svg: "<svg></svg>" }));
      expect(refused).toBeInstanceOf(AppToolError);
      expect(chunks).toEqual([]);
    }),
  );

  it("takes exactly one root element, with nothing after it", () => {
    for (const svg of [
      "<svg></svg><!--tail-->",
      "<svg></svg><?pi?>",
      "<svg></svg><svg></svg>",
      '<svg viewBox="0 0 1 1"/><rect/>',
      "<svg><g></svg>",
      "<svg><g></svg></g>",
      "<svg></g>",
      "<svg><!-- never closed </svg>",
    ]) {
      expect(widgetProblem(svg), svg).not.toBe(undefined);
    }
    for (const svg of [
      '<svg aria-label="latency > target"><rect/></svg>',
      "<svg><svg><rect/></svg></svg>\n",
      "<svg><style><![CDATA[ a > b { fill: red } </svg> ]]></style></svg>",
      "<svg><!-- </svg> --><text>a &gt; b</text></svg>",
      '<!-- source: <svg> --><svg><rect fill="var(--fg)"/></svg>',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg/>',
    ]) {
      expect(widgetProblem(svg), svg).toBe(undefined);
    }
  });

  it("accepts a declaration and comments before the root, and caps the size", () => {
    expect(
      widgetProblem('<?xml version="1.0"?>\n<!-- chart -->\n<svg viewBox="0 0 1 1"></svg>\n'),
    ).toBe(undefined);
    expect(widgetProblem('<svg viewBox="0 0 1 1"/>')).toBe(undefined);
    expect(widgetProblem(`<svg>${" ".repeat(WIDGET_MAX_LENGTH)}</svg>`)).toMatch(/limit/);
    expect(widgetProblem("<svgfoo></svgfoo>")).toMatch(/one SVG document/);
  });
});
