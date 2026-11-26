import { Layers } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GroupPick, groupChoices } from "@/orchestration/rail-model";

const CHIP =
  "shrink-0 gap-1 text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground";

/**
 * The Board's filter by group, above the lines: every line, one group's or those in none, each
 * with how many lines it keeps. A group is a tag on its lines, not a band over them, so this is
 * where the Board shows one effort's lines together. A group with no line on the Board has no
 * choice, and with no line in a group there is no filter.
 */
export function GroupFilter({
  choices,
  picked,
  onPick,
  className,
}: {
  choices: ReturnType<typeof groupChoices>;
  picked: GroupPick;
  onPick: (pick: GroupPick) => void;
  className?: string;
}) {
  if (choices.groups.length === 0) return null;
  const isPicked = (group: string) =>
    picked !== undefined && picked !== "ungrouped" && picked.group === group;
  return (
    <div
      data-testid="board-group-filter"
      role="group"
      aria-label="Show group"
      className={cn("flex shrink-0 flex-wrap gap-1", className)}
    >
      <Button
        size="xs"
        variant="ghost"
        data-testid="board-group-pick"
        aria-pressed={picked === undefined}
        onClick={() => onPick(undefined)}
        className={CHIP}
      >
        All
      </Button>
      {choices.groups.map(({ group, count }) => (
        <Button
          key={group}
          size="xs"
          variant="ghost"
          data-testid="board-group-pick"
          data-group={group}
          aria-pressed={isPicked(group)}
          onClick={() => onPick(isPicked(group) ? undefined : { group })}
          className={CHIP}
        >
          <Layers aria-hidden className="size-icon-row" />
          <span className="max-w-40 truncate">{group}</span>
          <span className="tabular-nums opacity-80">{count}</span>
        </Button>
      ))}
      {choices.ungrouped > 0 && (
        <Button
          size="xs"
          variant="ghost"
          data-testid="board-group-pick"
          data-group=""
          aria-pressed={picked === "ungrouped"}
          onClick={() => onPick(picked === "ungrouped" ? undefined : "ungrouped")}
          className={CHIP}
        >
          No group
          <span className="tabular-nums opacity-80">{choices.ungrouped}</span>
        </Button>
      )}
    </div>
  );
}
