import { GitBranch } from "lucide-react";

import { Badge } from "@/components/ui/badge";

/** Marks a git repository, with its branch when known. */
export function GitBadge({ branch }: { branch?: string | undefined }) {
  return (
    <Badge
      variant="outline"
      className="h-5 shrink-0 gap-0.5 px-1.5 text-meta font-normal text-muted-foreground"
    >
      <GitBranch aria-hidden />
      {branch ?? "git"}
    </Badge>
  );
}
