import { Ellipsis } from "lucide-react";
import type { ComponentType, ReactElement, ReactNode } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";

/** One thing a Settings list row can do, the same in its ⋯ menu and its right-click menu. */
export interface RowAction {
  readonly label: string;
  readonly icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  readonly onSelect: () => void;
  /** Removes something: drawn in the destructive colour. It should confirm before it does. */
  readonly danger?: boolean;
  /** While another action on the row runs. */
  readonly disabled?: boolean;
}

const DANGER = "text-destructive data-[highlighted]:text-destructive";

/** The ⋯ at a row's end. `label` names it, such as "Gateway Staging actions". */
export function RowMenuButton({
  label,
  actions,
}: {
  label: string;
  actions: readonly RowAction[];
}) {
  if (actions.length === 0) return null;
  return (
    <Menu>
      <Hint
        label="More actions"
        render={
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={label}
                className="text-muted-foreground hover:text-foreground"
              />
            }
          />
        }
      >
        <Ellipsis aria-hidden />
      </Hint>
      <MenuContent>
        {actions.map((action) => (
          <MenuItem
            key={action.label}
            disabled={action.disabled === true}
            danger={action.danger === true}
            onClick={action.onSelect}
          >
            <action.icon aria-hidden className="size-icon-row" />
            {action.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/**
 * A row whose right-click opens the same actions as its ⋯. Put it on the row's own line, not on a
 * form under it, so a right-click in a text field still gets the field's own menu.
 */
export function RowContextMenu({
  actions,
  render,
  children,
}: {
  actions: readonly RowAction[];
  /** The row element, with its own role, label and classes. */
  render: ReactElement;
  children: ReactNode;
}) {
  return (
    <ContextMenu disabled={actions.length === 0}>
      <ContextMenuTrigger render={render}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map((action) => (
          <ContextMenuItem
            key={action.label}
            disabled={action.disabled === true}
            className={cn(action.danger && DANGER)}
            onClick={action.onSelect}
          >
            <action.icon aria-hidden className="size-icon-row" />
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
