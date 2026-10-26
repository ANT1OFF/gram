import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { drawOn, Shimmer } from "@/motion";

/**
 * A centred status line for empty and loading panel states. `loading` runs the sheen over it that
 * the Files panel's loading lines already have, so a panel that is fetching doesn't read as empty.
 * `icon` marks an empty state above the words, drawn on as it appears.
 */
export function PanelMessage({
  loading = false,
  icon: Icon,
  children,
}: {
  loading?: boolean;
  icon?: LucideIcon | undefined;
  children: ReactNode;
}) {
  return (
    <p
      role="status"
      className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground"
    >
      {Icon && <Icon aria-hidden ref={drawOn} strokeWidth={1.5} className="size-6 opacity-70" />}
      <span>{loading ? <Shimmer>{children}</Shimmer> : children}</span>
    </p>
  );
}
