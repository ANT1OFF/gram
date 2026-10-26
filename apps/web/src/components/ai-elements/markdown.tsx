import { code } from "@streamdown/code";
import type { ComponentProps } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";

import { cn } from "@/lib/utils";
import { messageLinkSafety } from "@/links/link-dialog";
import { DrawnCheck } from "@/motion";

import type { MessageResponseProps } from "./message";

/**
 * Streamdown, its code highlighter and their markdown, HTML and Shiki dependencies: loaded on
 * demand through `markdown-loader.ts`, so none of it is in the app's first download.
 */

const streamdownPlugins = { code };

/** A code block's Copy turns into a check that draws itself, as every other copy button's does. */
const streamdownIcons = {
  CheckIcon: ({ className, ...props }: ComponentProps<typeof DrawnCheck>) => (
    <DrawnCheck {...props} className={cn("text-success", className)} />
  ),
};

type BuildPlugins = Extract<MessageResponseProps["rehypePlugins"], (...args: never) => unknown>;

/** One plugin list per builder, so streamdown keeps its processor between renders. */
const builtPlugins = new WeakMap<BuildPlugins, ReturnType<BuildPlugins>>();
const pluginsOf = (build: BuildPlugins) => {
  let plugins = builtPlugins.get(build);
  if (plugins === undefined) {
    plugins = build(defaultRehypePlugins);
    builtPlugins.set(build, plugins);
  }
  return plugins;
};

export function Markdown({ className, rehypePlugins, ...props }: MessageResponseProps) {
  return (
    <Streamdown
      className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      plugins={streamdownPlugins}
      icons={streamdownIcons}
      linkSafety={messageLinkSafety()}
      {...(rehypePlugins !== undefined && {
        rehypePlugins:
          typeof rehypePlugins === "function" ? pluginsOf(rehypePlugins) : rehypePlugins,
      })}
      {...props}
    />
  );
}
