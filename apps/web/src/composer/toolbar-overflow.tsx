import { Menu } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon, Ellipsis } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { PickerOption } from "./picker";

const POPUP =
  "z-50 min-w-48 origin-(--transform-origin) rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:size-3.5 [&_svg]:shrink-0";

/** A picker that no longer fits on the toolbar, offered in the "…" menu as a submenu. */
export interface FoldedPicker {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly value: string | undefined;
  readonly options: readonly (PickerOption<string> & { readonly disabled?: boolean })[];
  readonly onChange: (value: string) => void;
  readonly warning?: string | undefined;
  readonly description?: string | undefined;
}

/**
 * The composer toolbar's "…": the pickers that folded away when it got narrow. A folded
 * picker's shortcut opens this menu at its submenu, which `openSub` names.
 */
export function ToolbarOverflow({
  pickers,
  open,
  onOpenChange,
  openSub,
  onOpenSubChange,
}: {
  pickers: readonly FoldedPicker[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openSub: string | undefined;
  onOpenSubChange: (id: string | undefined) => void;
}) {
  return (
    <Menu.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Menu.Trigger
        data-testid="composer-overflow"
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="More composer controls"
            title="More composer controls"
            className="shrink-0 text-muted-foreground"
          />
        }
      >
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={6} className="isolate z-50">
          <Menu.Popup data-surface="overlay" data-testid="composer-overflow-menu" className={POPUP}>
            {pickers.map((picker) => (
              <Menu.SubmenuRoot
                key={picker.id}
                open={openSub === picker.id}
                onOpenChange={(next) => onOpenSubChange(next ? picker.id : undefined)}
              >
                <Menu.SubmenuTrigger
                  className={cn(
                    ITEM,
                    "data-[popup-open]:bg-accent",
                    picker.warning && "text-status-needs",
                  )}
                  title={picker.warning}
                >
                  {picker.icon}
                  {picker.label}
                  <span className="ml-auto pl-3 text-xs text-muted-foreground">
                    {picker.options.find((option) => option.value === picker.value)?.label}
                  </span>
                  <ChevronRightIcon aria-hidden />
                </Menu.SubmenuTrigger>
                <Menu.Portal>
                  <Menu.Positioner side="right" alignOffset={-4} className="isolate z-50">
                    <Menu.Popup data-surface="overlay" aria-label={picker.label} className={POPUP}>
                      <Menu.RadioGroup
                        value={picker.value ?? null}
                        onValueChange={(next: string | null) => {
                          if (next !== null) picker.onChange(next);
                        }}
                      >
                        {picker.options.map((option) => (
                          <Menu.RadioItem
                            key={option.value}
                            value={option.value}
                            disabled={option.disabled}
                            closeOnClick
                            className={ITEM}
                          >
                            <span className="flex size-3.5 items-center justify-center">
                              <Menu.RadioItemIndicator>
                                <CheckIcon aria-hidden />
                              </Menu.RadioItemIndicator>
                            </span>
                            {option.label}
                          </Menu.RadioItem>
                        ))}
                      </Menu.RadioGroup>
                      {picker.description && (
                        <p className="max-w-72 px-2 py-1 text-xs text-muted-foreground">
                          {picker.description}
                        </p>
                      )}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.SubmenuRoot>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
