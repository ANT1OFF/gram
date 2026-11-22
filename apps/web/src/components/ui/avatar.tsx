import type { ComponentType, CSSProperties } from "react";

import { cn } from "@/lib/utils";

/** The status a mark's dot shows: each one of Gram's status colours, or none. */
export type AvatarStatus = "success" | "working" | "waiting" | "needs" | "idle" | "error";

/** A glyph drawn in place of initials, at the size its `className` sets. */
export type AvatarGlyph = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export type AvatarSize = "xs" | "sm" | "md";

/** A status and its words, together: a dot never says its status by colour alone. */
export type AvatarStatusProps =
  | { status?: undefined; statusLabel?: undefined }
  | {
      status: AvatarStatus;
      /** The status in words, for a screen reader and the dot's hover. */
      statusLabel: string;
    };

interface AvatarBaseProps {
  name: string;
  shape?: "round" | "square";
  glyph?: AvatarGlyph;
  initials?: string;
  dimmed?: boolean;
  labelled?: boolean;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

/** A mark without its size, as a row that sizes it takes it. */
export type AvatarMarkProps = AvatarBaseProps & AvatarStatusProps;

export type AvatarProps = AvatarMarkProps & {
  /** 20, 28 or 36 px. Defaults to `md`. */
  size?: AvatarSize;
};

const TILE: Readonly<Record<AvatarSize, string>> = {
  xs: "size-5 text-caption leading-none",
  sm: "size-7 text-caption",
  md: "size-9 text-meta",
};

const GLYPH: Readonly<Record<AvatarSize, string>> = {
  xs: "size-3!",
  sm: "size-3.5!",
  md: "size-4!",
};

const DOT_SIZE: Readonly<Record<AvatarSize, string>> = {
  xs: "-right-0.5 -bottom-0.5 size-2 ring-[1.5px]",
  sm: "-right-0.5 -bottom-0.5 size-2.5 ring-2",
  md: "-right-0.5 -bottom-0.5 size-2.5 ring-2",
};

const AVATAR_DOT: Readonly<Record<AvatarStatus, string>> = {
  success: "bg-success",
  working: "bg-status-working",
  waiting: "border border-status-working bg-(--mark-ground,var(--color-background))",
  needs: "bg-status-needs-mark",
  idle: "bg-status-idle",
  error: "bg-destructive",
};

const firstLetter = (word: string | undefined) =>
  word === undefined ? "" : (Array.from(word)[0] ?? "");

/** Up to two letters for a name: its first word's first and its last word's first. */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "");
  const letters =
    words.length > 1 ? firstLetter(words[0]) + firstLetter(words.at(-1)) : firstLetter(words[0]);
  return letters.toLocaleUpperCase();
}

/**
 * A person's or an agent's mark: initials or a glyph in a round or square tile on the neutral
 * fill, with an optional status dot in one of the status colours, still.
 */
export function Avatar({
  name,
  shape = "round",
  glyph: Glyph,
  initials,
  status,
  statusLabel,
  size = "md",
  dimmed = false,
  labelled = false,
  className,
  style,
  testId,
}: AvatarProps) {
  const spoken = statusLabel === undefined ? name : `${name}, ${statusLabel}`;
  return (
    <span
      data-testid={testId}
      data-shape={shape}
      data-status={status}
      role={labelled ? "img" : undefined}
      aria-label={labelled ? spoken : undefined}
      aria-hidden={labelled ? undefined : true}
      className="relative inline-flex shrink-0"
    >
      <span
        className={cn(
          "grid place-items-center overflow-hidden border border-border bg-muted font-medium text-muted-foreground select-none",
          shape === "round"
            ? "rounded-full"
            : size === "xs"
              ? "rounded-2xs"
              : "rounded-(--radius-sm)",
          TILE[size],
          dimmed && "opacity-60",
          className,
        )}
        style={style}
      >
        {Glyph === undefined ? (
          Array.from(initials ?? initialsOf(name))
            .slice(0, size === "xs" ? 1 : 2)
            .join("")
        ) : (
          <Glyph aria-hidden className={GLYPH[size]} />
        )}
      </span>
      {status !== undefined && (
        <span
          data-testid={testId === undefined ? undefined : `${testId}-status`}
          title={statusLabel}
          className={cn(
            "absolute rounded-full ring-(--mark-ground,var(--color-background))",
            DOT_SIZE[size],
            AVATAR_DOT[status],
          )}
        />
      )}
    </span>
  );
}
