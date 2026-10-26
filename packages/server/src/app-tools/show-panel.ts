import { AppToolError, PanelKind, previewFileTarget, previewUrl } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { EventHub } from "../events/event-hub.ts";
import { defineAppTool } from "./definition.ts";

export const showPanelTool = (hub: EventHub["Service"]) =>
  defineAppTool({
    descriptor: {
      name: "show_panel",
      class: "self",
      description:
        "Open a panel for the user: `diff` at a file path, `pr`, `files` previewing a file, or `preview` with a localhost port or URL, which opens the Preview tab beside the thread showing that page (the user's own browser where the app can't), or with an absolute path to a Markdown or HTML file you wrote, such as a report or dashboard, which it renders there. Loopback only, and an HTML file loads only what sits beside it; to read or drive a page on a port, use the browser_* tools.",
    },
    input: Schema.Struct({ panel: PanelKind, target: Schema.optionalKey(Schema.String) }),
    handle: (threadId, { panel, target }) =>
      Effect.gen(function* () {
        const resolved =
          panel === "preview" && target !== undefined
            ? (previewUrl(target) ?? previewFileTarget(target))
            : target;
        if (panel === "preview" && resolved === undefined) {
          return yield* new AppToolError({
            tool: "show_panel",
            message:
              "preview needs a localhost port, an http://localhost URL, or an absolute path to a Markdown or HTML file",
          });
        }
        const withTarget = resolved === undefined ? {} : { target: resolved };
        yield* hub.publish({ type: "ui.showPanel", threadId, panel, ...withTarget });
        return { shown: panel, ...withTarget };
      }),
  });
