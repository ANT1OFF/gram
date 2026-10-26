"use client";

import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";

import type { HTMLAttributes } from "react";
import { memo } from "react";
import type { defaultRehypePlugins, StreamdownProps } from "streamdown";

import { useMarkdown } from "./markdown-loader";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    data-slot="message-content"
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

/** Streamdown's props; `rehypePlugins` may also be built from streamdown's defaults once loaded. */
export type MessageResponseProps = Omit<StreamdownProps, "rehypePlugins"> & {
  rehypePlugins?:
    | StreamdownProps["rehypePlugins"]
    | ((defaults: typeof defaultRehypePlugins) => NonNullable<StreamdownProps["rehypePlugins"]>);
};

/**
 * Markdown, rendered once streamdown has loaded (see `markdown-loader.ts`). Until then the text
 * holds its place unseen, so nothing flashes as plain text; a failed load shows it plain.
 */
export const MessageResponse = memo(
  (props: MessageResponseProps) => {
    const { module, failed } = useMarkdown();
    if (module) return <module.Markdown {...props} />;
    return (
      <div
        data-testid="markdown-pending"
        aria-busy={failed ? undefined : true}
        className={cn(
          "size-full whitespace-pre-wrap break-words",
          !failed && "invisible",
          props.className,
        )}
      >
        {typeof props.children === "string" ? props.children : null}
      </div>
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children && nextProps.isAnimating === prevProps.isAnimating,
);

MessageResponse.displayName = "MessageResponse";
