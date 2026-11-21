import { code } from "@streamdown/code";
import type { ComponentProps } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";

import { cn } from "@/lib/utils";
import { messageLinkSafety } from "@/links/link-dialog";
import { DrawnCheck } from "@/motion";

import type { MessageResponseProps } from "./message";
import { rehypeNoRemoteResources } from "./remote-resources";

const streamdownPlugins = { code };

const streamdownIcons = {
  CheckIcon: ({ className, ...props }: ComponentProps<typeof DrawnCheck>) => (
    <DrawnCheck {...props} className={cn("text-success", className)} />
  ),
};

type BuildPlugins = Extract<MessageResponseProps["rehypePlugins"], (...args: never) => unknown>;
type Plugins = NonNullable<ReturnType<BuildPlugins>>;

const guarded = (plugins: Plugins): Plugins => [...plugins, rehypeNoRemoteResources];

const DEFAULT_PLUGINS = guarded(Object.values(defaultRehypePlugins));

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
