import type { ReactNode } from "react";

import { Avatar, type AvatarProps } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/** How a tag beside the name looks: quiet words, an outlined pill, or code. */
export type AvatarRowTagLook = "quiet" | "badge" | "code";

/** A tag after the name: words alone are `quiet`. */
export type AvatarRowTag =
  | string
  | { readonly label: string; readonly look?: AvatarRowTagLook; readonly hideOnPhone?: boolean };

/** The tone of a row's trailing status words. */
export type AvatarRowTone = "default" | "muted" | "success" | "working" | "needs" | "error";

export interface AvatarRowProps {
  /** The row's mark; the row sets its size. */
  avatar: Omit<AvatarProps, "size">;
  /** The name: words, or a link of your own around them. */
  name: ReactNode;
  tags?: readonly AvatarRowTag[];
  /** The line under the name: a title, what it acts through. */
  meta?: ReactNode;
  /** Muted words before the status, such as what it is doing; dropped where the row is narrow. */
  aside?: ReactNode;
  /** The trailing status, in words. */
  status?: ReactNode;
  statusTone?: AvatarRowTone;
  /** A 28 px mark and less height, for a dense list. */
  compact?: boolean;
  className?: string;
  testId?: string;
}

const TAG: Readonly<Record<AvatarRowTagLook, string>> = {
  quiet: "text-meta text-subtle",
  badge:
    "inline-flex h-5 items-center rounded-full border border-border px-2 text-meta text-foreground",
  code: "font-mono text-caption text-subtle",
};

const TONE: Readonly<Record<AvatarRowTone, string>> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  success: "text-success",
  working: "text-status-working",
  needs: "text-status-needs",
  error: "text-danger-text",
};

/**
 * A row for a person or an agent: its mark, its name with tags after it, a meta line under it,
 * and a status at the row's end.
 */
export function AvatarRow({
  avatar,
  name,
  tags = [],
  meta,
  aside,
  status,
  statusTone = "default",
  compact = false,
  className,
  testId,
}: AvatarRowProps) {
  return (
    <div
      data-testid={testId}
      className={cn("flex min-w-0 items-center gap-3", compact ? "py-1.5" : "py-2.5", className)}
    >
      <Avatar {...avatar} size={compact ? "sm" : "md"} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-body-strong">{name}</span>
          {tags.map((tag, index) => {
            const {
              label,
              look = "quiet",
              hideOnPhone = false,
            } = typeof tag === "string" ? { label: tag } : tag;
            return (
              <span
                key={`${index}-${label}`}
                data-look={look}
                className={cn("shrink-0 truncate", TAG[look], hideOnPhone && "max-sm:hidden")}
              >
                {label}
              </span>
            );
          })}
        </span>
        {meta !== undefined && (
          <span className="truncate text-meta text-muted-foreground">{meta}</span>
        )}
      </span>
      {aside !== undefined && (
        <span className="min-w-0 shrink truncate text-meta text-description max-lg:hidden">
          {aside}
        </span>
      )}
      {status !== undefined && (
        <span className={cn("shrink-0 text-meta", TONE[statusTone])}>{status}</span>
      )}
    </div>
  );
}
