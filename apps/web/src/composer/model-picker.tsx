import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, Search, Star } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { matchesModel, modelGroups, type ModelGroup } from "./models";

interface Option {
  value: string;
  label: string;
  description?: string | undefined;
}

const NO_FAVOURITES = () => false;

const ROW =
  "group/row flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

/**
 * The model picker once the list is long: a search box over the models, favourites first, each row
 * with the agent's mark, its description and a star. The trigger is the toolbar's ghost control,
 * like every other picker, or a form's select for `field`. <kbd>⇧↵</kbd> stars the highlighted
 * model; without `favourite` there are no stars.
 */
export function ModelCombobox({
  label,
  value,
  options,
  onChange,
  open,
  onOpenChange,
  icon,
  rowIcon,
  title,
  description,
  warning,
  labelled,
  favourite = NO_FAVOURITES,
  onToggleFavourite,
  field = false,
}: {
  label: string;
  value: string | undefined;
  options: readonly Option[];
  onChange: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: ReactNode;
  /** The mark beside each row: the agent the model runs on. */
  rowIcon?: ReactNode;
  title: string;
  description: string | undefined;
  /** Tints the trigger amber, as the compact picker does; `title` carries the reason. */
  warning?: string | undefined;
  labelled: boolean;
  favourite?: ((value: string) => boolean) | undefined;
  onToggleFavourite?: ((value: string) => void) | undefined;
  /** A form's select rather than a toolbar control: bordered, and the list opens below it. */
  field?: boolean;
}) {
  const highlighted = useRef<Option | undefined>(undefined);
  const groups = modelGroups(options, favourite);
  const selected = options.find((option) => option.value === value);

  return (
    <Combobox.Root<Option>
      items={groups as unknown as Option[]}
      value={selected ?? null}
      onValueChange={(next) => {
        if (next) onChange(next.value);
      }}
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      autoHighlight
      itemToStringLabel={(option) => option.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      filter={(option, query) => matchesModel(option, query)}
      onItemHighlighted={(option) => {
        highlighted.current = option;
      }}
    >
      <Combobox.Trigger
        aria-label={label}
        aria-description={description}
        title={title}
        data-warning={warning ? "true" : undefined}
        className={cn(
          field
            ? "flex h-8 w-fit max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-muted"
            : "flex h-7 w-fit items-center gap-1.5 rounded-[min(var(--radius-md),10px)] border border-transparent bg-transparent px-2 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none select-none hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[popup-open]:bg-accent",
          warning && "text-status-needs hover:text-status-needs",
        )}
      >
        {icon}
        <span data-toolbar-label className={cn("min-w-0 truncate", !labelled && "sr-only")}>
          {selected?.label ?? label}
        </span>
        <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          side={field ? "bottom" : "top"}
          align="start"
          sideOffset={4}
          className="isolate z-50"
        >
          <Combobox.Popup
            data-surface="overlay"
            data-testid="model-picker"
            aria-label="Models"
            className="flex w-80 max-w-(--available-width) origin-(--transform-origin) flex-col rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <div className="flex items-center gap-2 border-b border-border px-2.5">
              <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <Combobox.Input
                aria-label="Search models"
                placeholder="Search models…"
                className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                onKeyDown={(event) => {
                  // An IME takes ⇧↵ to accept a candidate; 229 is how some browsers report it.
                  const composing = event.nativeEvent.isComposing || event.keyCode === 229;
                  if (event.key !== "Enter" || !event.shiftKey || composing) return;
                  if (!highlighted.current || !onToggleFavourite) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onToggleFavourite(highlighted.current.value);
                }}
              />
            </div>
            <Combobox.Empty>
              <p className="px-3 py-3 text-sm text-muted-foreground">No model matches.</p>
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 empty:p-0">
              {(group: ModelGroup) => (
                <Combobox.Group key={group.label} items={group.items as Option[]}>
                  {/* A single section needs no heading: favourites are what make two. */}
                  {groups.length > 1 && (
                    <Combobox.GroupLabel className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
                      {group.label}
                    </Combobox.GroupLabel>
                  )}
                  <Combobox.Collection>
                    {(option: Option) => {
                      const starred = favourite(option.value);
                      return (
                        <Combobox.Item key={option.value} value={option} className={ROW}>
                          {rowIcon !== undefined && (
                            <span aria-hidden className="flex size-4 shrink-0 items-center">
                              {rowIcon}
                            </span>
                          )}
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">{option.label}</span>
                            {option.description && (
                              <span className="truncate text-xs text-muted-foreground">
                                {option.description}
                              </span>
                            )}
                          </span>
                          <Combobox.ItemIndicator>
                            <CheckIcon aria-hidden className="size-3.5" />
                          </Combobox.ItemIndicator>
                          {/* Out of the tab order: the input keeps focus, and ⇧↵ stars from there. */}
                          {onToggleFavourite && (
                            <button
                              type="button"
                              tabIndex={-1}
                              aria-label={
                                starred
                                  ? `Remove ${option.label} from favourites`
                                  : `Add ${option.label} to favourites`
                              }
                              aria-pressed={starred}
                              title={starred ? "Remove from favourites (⇧↵)" : "Favourite (⇧↵)"}
                              className={cn(
                                "grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:text-foreground",
                                !starred &&
                                  "opacity-0 group-hover/row:opacity-100 group-data-[highlighted]/row:opacity-100",
                              )}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onToggleFavourite(option.value);
                              }}
                            >
                              <Star
                                aria-hidden
                                className={cn("size-3.5", starred && "fill-current text-warning")}
                              />
                            </button>
                          )}
                        </Combobox.Item>
                      );
                    }}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
