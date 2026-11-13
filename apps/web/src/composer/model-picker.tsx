import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, Search, Star } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode, type RefObject } from "react";

import { Hint } from "@/components/hint";
import { keyLabel } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { PulseOnce, Swap } from "@/motion";

import { aboveComposer } from "./above-composer";
import { LEGACY_GROUP, legacyCount, matchesModel, modelGroups, type ModelGroup } from "./models";
import type { PickerOption } from "./picker";
import { labelSize, usePickConfirm, ValueWords, type LabelSize } from "./picker-trigger";
import { compactModelName } from "./options";
import { GHOST_TRIGGER } from "./styles";

type Option = PickerOption<string>;

const NO_FAVOURITES = () => false;

/** A group's heading drawn as a mark with its words on hover, as each agent's in the composer. */
export interface GroupHead {
  readonly mark: ReactNode;
  readonly hint: string;
}
export type GroupHeads = Readonly<Record<string, GroupHead>>;

/**
 * The fold of superseded models (`PickerOption.legacy`): shut until opened or a search runs, which
 * finds them as it finds the rest. Starred ones stay with the favourites, and the model in use with
 * its own section, so neither ever hides.
 */
function useLegacyFold(options: readonly Option[], favourite: (value: string) => boolean) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  return {
    groups: modelGroups(options, favourite, open || searching),
    fold: {
      count: legacyCount(options, favourite),
      open,
      searching,
      onToggle: () => setOpen((was) => !was),
    },
    onQuery: setQuery,
    close: () => setOpen(false),
  };
}

type LegacyFold = ReturnType<typeof useLegacyFold>["fold"];

/**
 * Legacy models' fold: a chevron, its name and its count, as the overview's folds are. Opened, it
 * heads the section it opened and brings it into view, since it opens past the list's end.
 */
function LegacyFoldButton({ fold }: { fold: LegacyFold }) {
  // Once, as the opened heading mounts: on every render it would undo the user's own scrolling.
  const reveal = useCallback(
    (node: HTMLButtonElement | null) => {
      if (fold.open) node?.scrollIntoView?.({ block: "start" });
    },
    [fold.open],
  );
  return (
    <button
      type="button"
      aria-expanded={fold.open}
      data-testid="legacy-models"
      ref={reveal}
      // The search box keeps focus, so typing and the arrow keys carry on.
      onPointerDown={(event) => event.preventDefault()}
      onClick={fold.onToggle}
      className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-caption font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
    >
      {fold.open ? (
        <ChevronDownIcon aria-hidden className="size-icon-chip shrink-0" />
      ) : (
        <ChevronRightIcon aria-hidden className="size-icon-chip shrink-0" />
      )}
      <span className="flex-1">Legacy models</span>
      <span className="tabular-nums">{fold.count}</span>
    </button>
  );
}

const ROW =
  "group/row flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-body outline-none select-none data-[highlighted]:row-cursor";

/**
 * The model picker: a search box over the models, favourites first, then a section per agent or
 * gateway (and Custom), each row with its agent's mark, its description and a star, and superseded
 * models folded under Legacy models (`useLegacyFold`). The trigger is
 * the toolbar's ghost control, like every other picker, or a form's select for `field`. Typing
 * filters by name and provider, ↑↓ move, <kbd>↵</kbd> picks, <kbd>⇧↵</kbd> stars the highlighted
 * model and <kbd>Esc</kbd> closes; without `onToggleFavourite` there are no stars.
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
  tip,
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
  /** The mark beside each row: the agent the model runs on, unless the option has its own. */
  rowIcon?: ReactNode;
  title: string;
  /** The toolbar trigger's tooltip, as the toolbar's other pickers have; else `title`. */
  tip?: string | undefined;
  description: string | undefined;
  /** Tints the trigger amber, as the compact picker does; `title` carries the reason. */
  warning?: string | undefined;
  /** The name in full, in short ("Opus"), or the agent's mark alone; see `PickerTrigger`. */
  labelled: boolean | LabelSize;
  favourite?: ((value: string) => boolean) | undefined;
  onToggleFavourite?: ((value: string) => void) | undefined;
  /** A form's select rather than a toolbar control: bordered, and the list opens below it. */
  field?: boolean;
}) {
  const highlighted = useRef<Option | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const legacy = useLegacyFold(options, favourite);
  const groups = legacy.groups;
  // A single unnamed section needs no heading; an agent's or a gateway's name always says whose.
  // With a Legacy fold the list's own section is named too, so it doesn't gain a heading on opening.
  const headed =
    groups.length > 1 ||
    legacy.fold.count > 0 ||
    options.some((option) => option.group !== undefined);
  const selected = options.find((option) => option.value === value);
  const confirm = usePickConfirm(value);
  const shown = selected?.label ?? label;
  // In full the trigger says the name itself; shorter, its name and tooltip say it whole.
  const whole = labelSize(labelled) === "full";

  const triggerProps = {
    ref: trigger,
    "aria-label": whole ? label : `${label}: ${shown}`,
    "aria-description": description,
    // A form's field says it natively; on a toolbar the instant tooltip says it, whatever the size.
    title: field ? title : undefined,
    "data-warning": warning ? "true" : undefined,
    className: cn(
      field
        ? "flex h-8 w-fit max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-reading whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-muted"
        : cn(
            "flex w-fit max-w-full min-w-0 items-center rounded-[min(var(--radius-md),10px)] border bg-transparent whitespace-nowrap transition-colors outline-none select-none",
            GHOST_TRIGGER,
          ),
      warning && "text-warning hover:text-warning",
    ),
  };
  const glyph = icon !== undefined && icon !== null && icon !== false && (
    <PulseOnce trigger={confirm.landed} when={confirm.landed > 0}>
      <Swap swapKey={value}>{icon}</Swap>
    </PulseOnce>
  );
  const triggerContent = (
    <>
      {glyph}
      <ValueWords
        value={shown}
        compact={field ? undefined : (selected?.compact ?? compactModelName(shown))}
        labelled={labelled}
      />
      {/* Only beside the name in full, or in a form's field. */}
      {(whole || field) && (
        <ChevronDownIcon aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
      )}
    </>
  );

  return (
    <Combobox.Root<Option>
      items={groups as unknown as Option[]}
      value={selected ?? null}
      onValueChange={(next) => {
        if (!next) return;
        confirm.pick(next.value);
        onChange(next.value);
      }}
      open={open}
      onOpenChange={(next) => {
        if (!next) legacy.close();
        onOpenChange(next);
      }}
      onInputValueChange={legacy.onQuery}
      autoHighlight
      itemToStringLabel={(option) => option.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      filter={(option, query) => matchesModel(option, query)}
      onItemHighlighted={(option) => {
        highlighted.current = option;
      }}
    >
      {field ? (
        <Combobox.Trigger {...triggerProps}>{triggerContent}</Combobox.Trigger>
      ) : (
        // One element whatever its size: a trigger that changed shape between its full and short
        // forms remounted as the row re-laid itself out, and closed the list it had just opened.
        <Hint
          label={tip ?? (whole ? title : `${label}: ${shown}`)}
          render={<Combobox.Trigger {...triggerProps} />}
        >
          {triggerContent}
        </Hint>
      )}
      <Combobox.Portal>
        {/* On a toolbar, above the whole composer: over it, the list hid the draft being written. */}
        <Combobox.Positioner
          side={field ? "bottom" : "top"}
          {...(field ? {} : { anchor: () => aboveComposer(trigger.current) })}
          align="start"
          sideOffset={4}
          className="isolate z-50"
        >
          <Combobox.Popup
            data-surface="overlay"
            data-testid="model-picker"
            aria-label="Models"
            className="flex w-80 max-w-(--available-width) origin-(--transform-origin) flex-col rounded-md border border-edge bg-popover text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <ModelSearchBody
              headed={headed}
              rowIcon={rowIcon}
              favourite={favourite}
              onToggleFavourite={onToggleFavourite}
              highlighted={highlighted}
              legacy={legacy.fold}
            />
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

/**
 * The model list's search box, its empty state and its sections: favourites first, then a section
 * per agent or gateway, each row with its mark, its description and a star. Inside a
 * `Combobox.Root`, in its popup or inline.
 */
function ModelSearchBody({
  headed,
  rowIcon,
  favourite,
  onToggleFavourite,
  highlighted,
  heads,
  firstGroup,
  legacy,
}: {
  headed: boolean;
  rowIcon: ReactNode;
  favourite: (value: string) => boolean;
  onToggleFavourite: ((value: string) => void) | undefined;
  highlighted: RefObject<Option | undefined>;
  heads?: GroupHeads | undefined;
  /** The list's first group, whose heading has no hairline above it. */
  firstGroup?: string | undefined;
  legacy: LegacyFold;
}) {
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-2.5">
        <Search aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
        <Combobox.Input
          aria-label="Search models"
          placeholder="Search models…"
          className="h-9 w-full bg-transparent text-reading outline-none placeholder:text-muted-foreground"
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
        <p className="px-3 py-3 text-reading text-muted-foreground">No model matches.</p>
      </Combobox.Empty>
      <Combobox.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 empty:p-0">
        {(group: ModelGroup) => (
          <Combobox.Group key={group.label} items={group.items as Option[]}>
            {headed &&
              (group.label === LEGACY_GROUP && !legacy.searching ? (
                <Combobox.GroupLabel className="mt-1">
                  <LegacyFoldButton fold={legacy} />
                </Combobox.GroupLabel>
              ) : heads?.[group.label] === undefined ? (
                <Combobox.GroupLabel className="px-2 pt-2 pb-1 text-caption font-medium text-muted-foreground">
                  {group.label}
                </Combobox.GroupLabel>
              ) : (
                // The agent's mark alone, its words on hover and to a screen reader.
                <Combobox.GroupLabel
                  data-testid="model-group-head"
                  className={cn(
                    "flex px-2 pt-2 pb-1 text-muted-foreground",
                    group.label !== firstGroup && "mt-1 border-t border-border",
                  )}
                >
                  <Hint
                    label={heads[group.label]!.hint}
                    side="right"
                    render={
                      <span
                        role="img"
                        tabIndex={-1}
                        aria-label={heads[group.label]!.hint}
                        data-testid="model-group-mark"
                        className="flex items-center"
                      />
                    }
                  >
                    {heads[group.label]!.mark}
                  </Hint>
                </Combobox.GroupLabel>
              ))}
            <Combobox.Collection>
              {(option: Option) => {
                const starred = favourite(option.value);
                return (
                  // Named by the model alone: the star inside would otherwise join its name.
                  <Combobox.Item
                    key={option.value}
                    value={option}
                    disabled={option.disabled === true}
                    aria-label={option.label}
                    aria-description={option.description}
                    className={cn(ROW, option.disabled && "opacity-50")}
                  >
                    {(option.icon ?? rowIcon) !== undefined && (
                      <span
                        aria-hidden
                        className="flex size-4 shrink-0 items-center text-muted-foreground"
                      >
                        {option.icon ?? rowIcon}
                      </span>
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{option.label}</span>
                      {option.description && (
                        <span className="truncate text-meta text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                    <Combobox.ItemIndicator>
                      <CheckIcon aria-hidden className="size-icon-row" />
                    </Combobox.ItemIndicator>
                    {/* Out of the tab order: the input keeps focus, and ⇧↵ stars from there. */}
                    {onToggleFavourite && option.opens !== true && (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={
                          starred
                            ? `Remove ${option.label} from favourites`
                            : `Add ${option.label} to favourites`
                        }
                        aria-pressed={starred}
                        title={keyLabel(starred ? "Remove from favourites (⇧↵)" : "Favourite (⇧↵)")}
                        className={cn(
                          "grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:text-foreground",
                          // Every row shows its star, faint until the row is under the pointer.
                          !starred &&
                            "opacity-40 group-hover/row:opacity-100 group-data-[highlighted]/row:opacity-100",
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
                          className={cn("size-icon-row", starred && "fill-current text-foreground")}
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
      {/* Shut, the fold closes the list; open, it heads its section in the list instead. A search
          lists the superseded models it finds, so the fold has nothing to open then. */}
      {legacy.count > 0 && !legacy.searching && !legacy.open && <LegacyFoldButton fold={legacy} />}
    </>
  );
}

/**
 * The model list inline, open for as long as it shows: the Model section of the composer's
 * choices. Typing filters, ↑↓ move, <kbd>↵</kbd> picks and <kbd>⇧↵</kbd> stars, as in
 * `ModelCombobox`.
 */
export function ModelSearch({
  value,
  options,
  onChange,
  rowIcon,
  favourite = NO_FAVOURITES,
  onToggleFavourite,
  heads,
}: {
  value: string | undefined;
  options: readonly Option[];
  onChange: (value: string) => void;
  rowIcon?: ReactNode;
  favourite?: ((value: string) => boolean) | undefined;
  onToggleFavourite?: ((value: string) => void) | undefined;
  /** Group headings drawn as a mark, by group label; the rest say their label. */
  heads?: GroupHeads | undefined;
}) {
  const highlighted = useRef<Option | undefined>(undefined);
  const legacy = useLegacyFold(options, favourite);
  const groups = legacy.groups;
  // With a Legacy fold the list's own section is named too, so it doesn't gain a heading on opening.
  const headed =
    groups.length > 1 ||
    legacy.fold.count > 0 ||
    options.some((option) => option.group !== undefined);
  const selected = options.find((option) => option.value === value);
  return (
    <Combobox.Root<Option>
      inline
      open
      items={groups as unknown as Option[]}
      value={selected ?? null}
      onValueChange={(next) => {
        if (next) onChange(next.value);
      }}
      onInputValueChange={legacy.onQuery}
      autoHighlight
      itemToStringLabel={(option) => option.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      filter={(option, query) => matchesModel(option, query)}
      onItemHighlighted={(option) => {
        highlighted.current = option;
      }}
    >
      <div data-model-search data-testid="model-picker" className="flex flex-col">
        <ModelSearchBody
          headed={headed}
          rowIcon={rowIcon}
          favourite={favourite}
          onToggleFavourite={onToggleFavourite}
          highlighted={highlighted}
          heads={heads}
          firstGroup={groups[0]?.label}
          legacy={legacy.fold}
        />
      </div>
    </Combobox.Root>
  );
}
