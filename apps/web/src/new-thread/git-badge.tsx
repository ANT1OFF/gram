import { GitBranch } from "lucide-react";

import { Badge } from "@/components/ui/badge";

/** Marks a git repository, with its branch when known. */
export function GitBadge({ branch }: { branch?: string | undefined }) {
  return (
    <Badge
      variant="outline"
      className="h-4 shrink-0 gap-0.5 px-1.5 text-[10px] font-normal text-muted-foreground"
    >
      <GitBranch aria-hidden />
      {branch ?? "git"}
    </Badge>
  );
}
