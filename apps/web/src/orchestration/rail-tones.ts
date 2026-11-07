import { CircleAlert, CircleDot, GitMerge, Hourglass, type LucideIcon } from "lucide-react";

import { Spinner } from "@/motion";

import type { RailTone } from "./rail-model";
import { STATUS_WORDS } from "./status-words";

/** A chip's tone as an icon, on the Board and in the sheet. */
export const RAIL_TONES: Readonly<
  Record<RailTone, { icon: LucideIcon; tone: string; label: string }>
> = {
  needs: { icon: CircleAlert, tone: "text-status-needs-mark", label: STATUS_WORDS.needs },
  attention: { icon: CircleDot, tone: "text-status-idle", label: STATUS_WORDS.attention },
  error: { icon: CircleAlert, tone: "text-destructive", label: STATUS_WORDS.error },
  working: { icon: Spinner, tone: "text-status-working", label: STATUS_WORDS.working },
  waiting: { icon: Hourglass, tone: "text-status-working", label: STATUS_WORDS.waiting },
  idle: { icon: CircleDot, tone: "text-status-idle", label: STATUS_WORDS.idle },
  merged: { icon: GitMerge, tone: "text-merged", label: STATUS_WORDS.merged },
};
