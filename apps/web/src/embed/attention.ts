import { useNavigate } from "@tanstack/react-router";

import { showInbox } from "@/inbox/inbox-store";

import { useEmbedShell } from "./store";

/** The embedding app's count of what needs someone, ready to draw, or undefined for Gram's own. */
export interface HostAttention {
  readonly count: number;
  /** The pill's words. */
  readonly words: string;
  readonly open: () => void;
}

/** The pill's words for `count` when the embedding app gave none. */
export const attentionWords = (count: number, label: string | undefined): string =>
  label !== undefined && label.trim() !== "" ? label : `${count} need you`;

/**
 * What needs someone as the embedding app counts it (`shell.attention`), or undefined while it
 * gives none: Gram's own Needs you then stands, as on Gram on its own.
 */
export function useHostAttention(): HostAttention | undefined {
  const attention = useEmbedShell((s) => s.attention);
  const navigate = useNavigate();
  if (attention === undefined) return undefined;
  const count = Number.isFinite(attention.count) ? Math.max(0, Math.floor(attention.count)) : 0;
  return {
    count,
    words: attentionWords(count, attention.label),
    open: () => {
      if (attention.to !== undefined) void navigate({ to: attention.to as "/" });
      else if (attention.onOpen !== undefined) attention.onOpen();
      else showInbox();
    },
  };
}
