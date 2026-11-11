import { Drawer } from "@base-ui/react/drawer";
import { Popover } from "@base-ui/react/popover";
import { CheckIcon, SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { shortcutHint } from "@/keyboard/bindings";
import { useBindingsStore } from "@/keyboard/bindings-store";
import { useShortcut } from "@/keyboard/registry";
import { withHint } from "@/keyboard/use-shortcut-hint";
import { usePhone } from "@/lib/use-phone";
import { cn } from "@/lib/utils";
import { PulseOnce } from "@/motion";

import { aboveComposer } from "./above-composer";
import { ChoicesSheet, chipWords } from "./choices-sheet";
import { ModelSearch } from "./model-picker";
import type { PickerOption } from "./picker";
import { GHOST_TRIGGER } from "./styles";

/** A row of a section's list; a disabled one says why in its description. */
export type ChoiceOption = PickerOption<string> & {
  readonly disabled?: boolean | undefined;
};

/**
 * One of the composer's dimensions (model, effort, mode or speed): a section of the choices
 * popover, and on the chip the model's name, the mode's glyph and Fast's bolt.
 */
export interface ChoiceSection {
  readonly id: string;
  /** What it picks: "Model", "Effort". */
  readonly label: string;
  /**
   * The value in words, for the chip's name and tooltip and the section's heading: "Claude Opus",
   * "Extra high", "Model default", "CLI default".
   */
  readonly named: string;
  /**
   * A 14 px glyph on the chip after the model's name: the mode's, Bypass's open lock in the warning
   * colour, and Fast's bolt while on. Absent, the value is said only in the chip's name and
   * tooltip, as every value is.
   */
  readonly glyph?: ReactNode;
  /** Why it doesn't apply here: its section is greyed and says so on hover. */
  readonly unavailable?: string | undefined;
  /** A caution on the value (Bypass): said in the tooltip, and its words in the popover warn. */
  readonly warning?: string | undefined;
  /** The shortcut that opens the popover on this section. */
  readonly shortcut?: { readonly id: string; readonly keys: string } | undefined;
  readonly value?: string | undefined;
  readonly options?: readonly ChoiceOption[] | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  /** Lines under the list: what Fast costs, what the CLI last reported. */
  readonly notes?: readonly string[] | undefined;
  /** A searching list with favourites in place of a plain one: the model's. */
  readonly search?:
    | {
        readonly rowIcon?: ReactNode;
        readonly favourite?: ((value: string) => boolean) | undefined;
        readonly onToggleFavourite?: ((value: string) => void) | undefined;
      }
    | undefined;
  /** What the section shows in place of its list, such as models still loading or failing. */
  readonly body?: ReactNode;
}

/** Registers one section's shortcut; a component, so the sections can come and go. */
function SectionShortcut({
  id,
  keys,
  label,
  enabled,
  run,
}: {
  id: string;
  keys: string;
  label: string;
  enabled: boolean;
  run: () => void;
}) {
  useShortcut({ id, keys, label: `Pick ${label.toLowerCase()}`, group: "Composer", run }, enabled);
  return null;
}

/** The keys that move between the popover's rows outside the model's search. */
const MOVES = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/**
 * The composer's one choices chip: the agent's mark, the model's name, then the mode's glyph and
 * Fast's bolt while on, and one popover with a section for each dimension, in words. The name is the
 * one word on the chip, and it truncates rather than goes when the toolbar is short of room; the
 * chip's name and tooltip say every value and its shortcut. Each section's shortcut opens the
 * popover on it, and a pick closes it.
 */
export function ComposerChoices({
  sections,
  mark,
  agentLabel,
  focused = false,
  onOpen,
  onClose,
  onAsked,
  onPicked,
}: {
  sections: readonly ChoiceSection[];
  /**
   * The agent the model runs on; absent where an agent picker beside it carries the mark, and the
   * chip then draws the sliders glyph in its place.
   */
  mark?: ReactNode;
  /** The agent's name, read after the chip's name. */
  agentLabel?: string | undefined;
  /** Registers the sections' shortcuts only for the focused pane. */
  focused?: boolean;
  /** Called as the popover opens, by click or shortcut. */
  onOpen?: (() => void) | undefined;
  /** Called as it closes, by a pick, Escape or a click away. */
  onClose?: (() => void) | undefined;
  /**
   * Subscribes to asks to open the model's section from outside the toolbar, such as a failed
   * turn's "Try another model"; returns the unsubscribe.
   */
  onAsked?: ((open: () => void) => () => void) | undefined;
  /** Told each pick in words, "Effort set to High", for a composer that confirms it there. */
  onPicked?: ((words: string) => void) | undefined;
}) {
  const phone = usePhone();
  const [open, setOpenState] = useState(false);
  const [active, setActive] = useState<string | undefined>(sections[0]?.id);
  // Counts openings, so each one starts its sections afresh: reopened while the last closing still
  // animates out, the model search would otherwise keep the query its pick left.
  const [opening, setOpening] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const base = useId();
  const overrides = useBindingsStore((s) => s.overrides);
  const hintOf = (section: ChoiceSection) =>
    section.shortcut === undefined ? "" : shortcutHint(section.shortcut.id, overrides);

  // A pick rings the mark once it lands, and not for a value that changed by itself.
  const [pending, setPending] = useState<{ id: string; value: string }>();
  const [landed, setLanded] = useState(0);
  if (
    pending !== undefined &&
    sections.find((section) => section.id === pending.id)?.value === pending.value
  ) {
    setPending(undefined);
    setLanded(landed + 1);
  }

  const setOpen = (next: boolean, at?: string) => {
    if (next) {
      onOpen?.();
      setActive(at ?? sections.find((section) => section.unavailable === undefined)?.id);
      if (!open) {
        setOpening(opening + 1);
        // A pick the server never took doesn't ring the mark for a later, unrelated change.
        setPending(undefined);
      }
    } else if (open) onClose?.();
    setOpenState(next);
  };
  // An ask from outside opens the model's section as its shortcut does. Kept in a ref, so a
  // re-render with new callbacks doesn't subscribe again.
  const asked = useRef(() => {});
  useEffect(() => {
    asked.current = () => setOpen(true, "model");
  });
  useEffect(() => onAsked?.(() => asked.current()), [onAsked]);

  /** A pick; the popover closes on it, the phone's sheet stays open for the next. */
  const pick = (section: ChoiceSection, option: ChoiceOption) => {
    if (option.disabled) return;
    if (!phone) setOpen(false);
    if (option.value === section.value) return;
    setPending({ id: section.id, value: option.value });
    section.onChange?.(option.value);
    onPicked?.(`${section.label} set to ${option.short ?? option.label}`);
  };

  const said = (section: ChoiceSection) =>
    section.unavailable !== undefined
      ? `${section.label}: ${section.unavailable}`
      : section.id === "model"
        ? section.named
        : `${section.label}: ${section.named}`;
  const name = sections.map((section) => withHint(said(section), hintOf(section))).join(" · ");
  const warnings = sections.flatMap((section) => (section.warning ? [section.warning] : []));
  // The tooltip names the agent the mark stands for before the model, "Codex · GPT-5.5".
  const tip = [
    ...sections.map((section) => {
      const line = withHint(said(section), hintOf(section));
      return section.id === "model" && agentLabel ? `${agentLabel} · ${line}` : line;
    }),
    ...warnings,
  ].join("\n");
  const description = [agentLabel, ...warnings].filter(Boolean).join(". ") || undefined;
  const glyphs = sections.flatMap((section) =>
    section.glyph === undefined || section.unavailable !== undefined
      ? []
      : [{ id: section.id, value: section.value, glyph: section.glyph }],
  );
  const model = sections.find((section) => section.id === "model");

  const rows = () => [...(popup.current?.querySelectorAll<HTMLElement>("[data-choice-row]") ?? [])];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!MOVES.has(event.key)) return;
    const target = event.target as HTMLElement;
    // The model's search moves through its own list.
    if (target.closest("[data-model-search]")) return;
    // Down from the open Model heading goes into its search, where its list is.
    const search =
      event.key === "ArrowDown" && target.getAttribute("aria-expanded") === "true"
        ? target.closest("[data-choice-section]")?.querySelector<HTMLElement>("input")
        : undefined;
    if (search) {
      event.preventDefault();
      search.focus();
      return;
    }
    const all = rows();
    if (all.length === 0) return;
    event.preventDefault();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? all.length - 1
          : event.key === "ArrowDown"
            ? (at + 1) % all.length
            : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  };
  /** Where focus lands as the popover opens: the search, else the open section's current value. */
  const initialFocus = () => {
    const el = popup.current;
    const section = el?.querySelector<HTMLElement>(`[data-choice-section="${active}"]`);
    return (
      section?.querySelector<HTMLElement>("input") ??
      section?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      section?.querySelector<HTMLElement>("[data-choice-row]") ??
      true
    );
  };

  const shortcuts = sections.map(
    (section) =>
      section.shortcut && (
        <SectionShortcut
          key={section.id}
          id={section.shortcut.id}
          keys={section.shortcut.keys}
          label={section.label}
          enabled={focused}
          run={() => setOpen(true, section.id)}
        />
      ),
  );
  const markGlyph = (
    <span aria-hidden className="flex shrink-0 items-center">
      <PulseOnce trigger={landed} when={landed > 0}>
        {mark ?? <SlidersHorizontal data-testid="choices-glyph" className="size-icon-bar" />}
      </PulseOnce>
    </span>
  );

  // A phone has no hover to say the values, so the chip says them in short words, and opens a sheet
  // from the bottom in place of the popover.
  if (phone)
    return (
      <Drawer.Root open={open} onOpenChange={(next) => setOpen(next)}>
        {shortcuts}
        <Drawer.Trigger
          ref={trigger}
          data-testid="composer-choices"
          aria-label={name}
          aria-description={description}
          data-warning={warnings.length > 0 ? "true" : undefined}
          className={cn(
            GHOST_TRIGGER,
            "inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 outline-none select-none",
            warnings.length > 0 && "text-warning hover:text-warning",
          )}
        >
          {markGlyph}
          <span data-testid="choices-words" className="min-w-0 truncate">
            {chipWords(sections)}
          </span>
        </Drawer.Trigger>
        <ChoicesSheet key={opening} sections={sections} onPick={pick} />
      </Drawer.Root>
    );

  return (
    <Popover.Root open={open} onOpenChange={(next) => setOpen(next)}>
      {shortcuts}
      <Hint
        label={tip}
        render={
          <Popover.Trigger
            ref={trigger}
            data-testid="composer-choices"
            aria-label={name}
            aria-description={description}
            data-warning={warnings.length > 0 ? "true" : undefined}
            className={cn(
              GHOST_TRIGGER,
              "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md px-1.5 outline-none select-none",
            )}
          />
        }
      >
        {markGlyph}
        {model !== undefined && model.unavailable === undefined && (
          <span
            aria-hidden
            data-testid="choices-model-name"
            className={cn("min-w-0 truncate", model.warning && "text-warning")}
          >
            {chipModelName(model.named)}
          </span>
        )}
        {glyphs.map(({ id, value, glyph }) => (
          <span
            key={id}
            aria-hidden
            data-chip-glyph={id}
            data-value={value}
            className="flex shrink-0 items-center"
          >
            {glyph}
          </span>
        ))}
      </Hint>
      <Popover.Portal>
        {/* Above the whole composer, so the popover never covers the draft. */}
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={4}
          anchor={() => aboveComposer(trigger.current)}
          className="isolate z-50"
        >
          <Popover.Popup
            ref={popup}
            data-surface="overlay"
            data-testid="composer-choices-popup"
            aria-label="Model, effort, mode and speed"
            initialFocus={initialFocus}
            onKeyDown={onKeyDown}
            className="flex max-h-(--available-height) w-80 max-w-(--available-width) origin-(--transform-origin) flex-col overflow-y-auto overscroll-contain rounded-md border border-edge bg-popover p-1 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            {sections.map((section, index) => (
              <Section
                key={`${section.id}-${opening}`}
                id={`${base}-${section.id}`}
                section={section}
                hint={hintOf(section)}
                expanded={active === section.id}
                first={index === 0}
                onExpand={() => setActive(section.id)}
                onPick={(option) => pick(section, option)}
              />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The model's name on the chip, as the model picker lists it less the vendor the agent's mark
 * already says: "Claude Opus 5.5" reads "Opus 5.5".
 */
export function chipModelName(named: string): string {
  return named.replace(/^(Claude|OpenAI)\s+/i, "").trim() || named;
}

const ROW =
  "relative flex w-full cursor-default items-center gap-2 rounded-sm text-body outline-none select-none hover:row-cursor focus-visible:row-cursor";

/**
 * One dimension in the popover: a heading that says its value and shortcut, and, once open, its
 * list with the current value checked and a line on what each costs. One section is open at a
 * time; one that doesn't apply is greyed, and says why on hover and once opened.
 */
function Section({
  id,
  section,
  hint,
  expanded,
  first,
  onExpand,
  onPick,
}: {
  id: string;
  section: ChoiceSection;
  hint: string;
  expanded: boolean;
  first: boolean;
  onExpand: () => void;
  onPick: (option: ChoiceOption) => void;
}) {
  const unavailable = section.unavailable !== undefined;
  const headingProps = {
    type: "button",
    "data-choice-row": true,
    id: `${id}-heading`,
    "aria-expanded": expanded,
    "aria-controls": `${id}-body`,
    "aria-disabled": unavailable || undefined,
    // Why it doesn't apply, said to a screen reader as the hint says it on hover.
    "aria-description": unavailable ? `${section.label}: ${section.unavailable}` : undefined,
    "data-testid": unavailable ? `unavailable-${section.id}` : `choices-${section.id}`,
    onClick: onExpand,
    className: cn(ROW, "h-8 px-2", unavailable && "opacity-50"),
  } as const;
  const words = (
    <>
      <span className={cn("shrink-0", expanded ? "font-medium" : "text-muted-foreground")}>
        {section.label}
      </span>
      <span
        className={cn(
          "ml-auto min-w-0 truncate",
          unavailable ? "text-muted-foreground" : section.warning && "text-warning",
        )}
      >
        {unavailable ? "Not available" : section.named}
      </span>
      {hint && (
        <kbd aria-hidden className="shrink-0 font-mono text-caption text-muted-foreground">
          {hint}
        </kbd>
      )}
    </>
  );
  // Why it doesn't apply, or why it warns, on hover and focus.
  const why = unavailable ? `${section.label}: ${section.unavailable}` : section.warning;
  const heading =
    why === undefined ? (
      <button {...headingProps}>{words}</button>
    ) : (
      <Hint label={why} side="right" render={<button {...headingProps} />}>
        {words}
      </Hint>
    );
  const options = section.options ?? [];
  const current = options.some((option) => option.value === section.value)
    ? section.value
    : options.find((option) => !option.disabled)?.value;
  return (
    <div
      role="group"
      aria-labelledby={`${id}-heading`}
      data-choice-section={section.id}
      className={cn(!first && "mt-1 border-t border-border pt-1")}
    >
      {heading}
      {expanded && (
        <div id={`${id}-body`} className="pb-1">
          {unavailable ? (
            <p className="px-2 pb-1 text-meta text-muted-foreground">{section.unavailable}</p>
          ) : section.body !== undefined ? (
            section.body
          ) : section.search ? (
            <ModelSearch
              value={section.value}
              options={options}
              onChange={(value) =>
                onPick(
                  options.find((option) => option.value === value) ?? {
                    value,
                    label: value,
                  },
                )
              }
              rowIcon={section.search.rowIcon}
              favourite={section.search.favourite}
              onToggleFavourite={section.search.onToggleFavourite}
            />
          ) : (
            <div role="listbox" aria-label={section.label}>
              {options.map((option) => {
                const selected = option.value === section.value;
                return (
                  <div
                    key={option.value}
                    role="option"
                    data-choice-row
                    aria-selected={selected}
                    aria-disabled={option.disabled || undefined}
                    aria-label={option.label}
                    aria-description={option.description}
                    tabIndex={option.value === current ? 0 : -1}
                    onClick={() => onPick(option)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onPick(option);
                    }}
                    className={cn(
                      ROW,
                      "py-1 pr-8 pl-2",
                      option.disabled && "pointer-events-none opacity-50",
                    )}
                  >
                    {option.icon !== undefined && (
                      <span
                        aria-hidden
                        className={cn(
                          "flex shrink-0 items-center text-muted-foreground",
                          option.description !== undefined && "self-start pt-1",
                        )}
                      >
                        {option.icon}
                      </span>
                    )}
                    {option.description === undefined ? (
                      <span className="min-w-0 truncate">{option.label}</span>
                    ) : (
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
                        <span className="truncate">{option.label}</span>
                        <span
                          aria-hidden
                          className="max-w-64 text-meta whitespace-normal text-muted-foreground"
                        >
                          {option.description}
                        </span>
                      </span>
                    )}
                    {selected && (
                      <CheckIcon
                        aria-hidden
                        className="pointer-events-none absolute right-2 size-icon-row"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!unavailable &&
            section.notes?.map((note) => (
              <p key={note} className="max-w-72 px-2 py-1 text-meta text-muted-foreground">
                {note}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
