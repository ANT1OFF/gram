import { code } from "@streamdown/code";
import type { ComponentProps } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";

import { cn } from "@/lib/utils";
import { messageLinkSafety } from "@/links/link-dialog";
import { DrawnCheck } from "@/motion";

import type { MessageResponseProps } from "./message";
import { rehypeNoRemoteResources } from "./remote-resources";

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
type Plugins = NonNullable<ReturnType<BuildPlugins>>;

/**
 * Every chain ends with `rehypeNoRemoteResources`, whatever its caller built, so no markdown asks
 * another origin for anything as it renders, even in a page with no CSP of its own.
 */
const guarded = (plugins: Plugins): Plugins => [...plugins, rehypeNoRemoteResources];

const DEFAULT_PLUGINS = guarded(Object.values(defaultRehypePlugins));

/** One plugin list per builder or list, so streamdown keeps its processor between renders. */
const builtPlugins = new WeakMap<BuildPlugins | Plugins, Plugins>();
const pluginsOf = (given: BuildPlugins | Plugins | undefined): Plugins => {
  if (given === undefined) return DEFAULT_PLUGINS;
  let plugins = builtPlugins.get(given);
  if (plugins === undefined) {
    plugins = guarded(typeof given === "function" ? given(defaultRehypePlugins) : given);
    builtPlugins.set(given, plugins);
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
      {...props}
      rehypePlugins={pluginsOf(rehypePlugins)}
    />
  );
}
