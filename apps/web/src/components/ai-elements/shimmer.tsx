"use client";

import type { ElementType } from "react";

import { Shimmer as MotionShimmer } from "@/motion";

export interface TextShimmerProps {
  children: string;
  /** Part of AI Elements' API, unused: the sheen renders as an inline span. */
  as?: ElementType;
  className?: string;
  /** Part of AI Elements' API, unused: timing comes from the active look. */
  duration?: number;
  spread?: number;
}

/** AI Elements' shimmer, delegating to the motion kit so it follows the look and motion setting. */
export const Shimmer = ({ children, className }: TextShimmerProps) => (
  <MotionShimmer {...(className ? { className } : {})}>{children}</MotionShimmer>
);
