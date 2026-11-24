import { Undo2 } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { ChoiceCheck } from "@/components/choice-check";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { inputCls } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CHOICE_CARD } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { SegmentSlab } from "@/motion";

import { FieldLayout, RowLabel, wordsOf, type FieldProps, type RichLabel } from "./field-frame";
import { isLongError } from "./long-error";
import { parseNumberDraft } from "./number-draft";
import { DraftActions, dropUndo, offerUndo, SaveHint, UndoSave } from "./save-hint";
import { SavedMark, touchHandlers } from "./saved-mark";
import { useSettingSearch } from "./search-scope";

export { inputCls };

/** A text input on the right of a `SettingRow`: a fixed width, narrower when the row is. */
export const rowInputCls = cn(inputCls, "w-64 max-w-full");

/**
 * A setting is a label of four words or fewer, one short line under it that says what it does, and
 * its control. `settings-copy.test.tsx` fails a page with a longer label or line. Text that has to be
 * read whole, such as a consent or a legal notice, carries this attribute, set to why, and is left
 * out of that count.
 */
export const LONG_COPY = "data-long-copy";

/** A labelled setting in a form: its name and one line of description, then the control below. */
export function Field({
  keywords,
  undoKey,
  ...props
}: FieldProps & {
  /** Extra words Settings search finds this by. */
  keywords?: readonly string[];
  /** A typed setting's key for `offerUndo`, whose Undo shows after "Saved". */
  undoKey?: string;
}) {
  const words = wordsOf(props);
  const search = useSettingSearch({ ...words, keywords });
  const row = useId();
  return (
    <FieldLayout
      {...props}
      rootProps={{ ...search, ...touchHandlers(row) }}
      receipt={
        <>
          <SavedMark row={row} />
          {undoKey !== undefined && <UndoSave undoKey={undoKey} />}
        </>
      }
    />
  );
}

const NESTED_ROW = "border-t-0! ps-9! pt-0!";

/**
 * One setting on one line of a `SettingsGroup` card: its name and one line of description on the
 * left, its control on the right, dropping below when the two don't fit side by side. `onReset` is
 * passed only while the value differs from its default, so the reset icon it shows also marks what
 * was changed. A change stored from the row says "Saved" (and Undo, for a typed one) just before
 * its control for a moment.
 */
export function SettingRow({
  label,
  labelText,
  description,
  keywords,
  htmlFor,
  onReset,
  error,
  disabledReason,
  detail,
  learnMore,
  hint,
  undoKey,
  nested = false,
  testId,
  children,
}: RichLabel & {
  /** Extra words Settings search finds this by. */
  keywords?: readonly string[];
  /** On the row, for specs to find it by. */
  testId?: string | undefined;
  /**
   * A part of the row above it: set in from the card's edge under that row's name, with no hairline
   * between the two.
   */
  nested?: boolean;
  /** The control's id, when it's a single form element the label should name. */
  htmlFor?: string;
  /** What the one line leaves out, behind the ⓘ beside the name. */
  learnMore?: ReactNode;
  /**
   * Under the control, right-aligned: such as how to keep a draft not saved yet. Kept off the name's
   * line, which holds only the name and its reset.
   */
  hint?: ReactNode;
  /** Puts the default back; absent while the value is the default. */
  onReset?: (() => void) | undefined;
  /** Why the last change to this setting failed, shown under the row. */
  error?: string | undefined;
  /** Why the control can't be used right now; set only while it is disabled. */
  disabledReason?: string | undefined;
  /** Full-width content under the row, such as a list the setting edits. */
  detail?: ReactNode;
  /** A typed setting's key for `offerUndo`, whose Undo shows beside "Saved", before the control. */
  undoKey?: string;
  children?: ReactNode;
}) {
  const words = wordsOf({ label, labelText, description });
  const search = useSettingSearch({ ...words, keywords });
  const row = useId();
  return (
    <div
      {...search}
      {...touchHandlers(row)}
      data-setting=""
      data-testid={testId}
      className={cn("@container/row flex flex-col gap-2", nested && NESTED_ROW)}
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_14rem]">
          <RowLabel
            label={label}
            labelText={words.label}
            htmlFor={htmlFor}
            description={description}
            learnMore={learnMore}
          >
            {onReset && <ResetButton label={words.label} onReset={onReset} />}
            {children === undefined && <SaveReceipt row={row} undoKey={undoKey} />}
          </RowLabel>
        </div>
        {children !== undefined && (
          <div className="ms-auto flex max-w-full min-w-0 flex-col items-end gap-1">
            <div className="relative flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">
              <span className="pointer-events-none absolute end-full top-1/2 me-2 -translate-y-1/2 *:pointer-events-auto">
                <SaveReceipt row={row} undoKey={undoKey} />
              </span>
              <WhyDisabled reason={disabledReason}>{children}</WhyDisabled>
            </div>
            {hint}
          </div>
        )}
      </div>
      {detail}
      {error && <ExpandableError message={error} />}
    </div>
  );
}

function SaveReceipt({ row, undoKey }: { row: string; undoKey: string | undefined }) {
  return (
    <span data-testid="setting-receipt" className="flex items-center gap-1 whitespace-nowrap">
      <SavedMark row={row} />
      {undoKey !== undefined && <UndoSave undoKey={undoKey} />}
    </span>
  );
}

function ResetButton({ label, onReset }: { label: string; onReset: () => void }) {
  return (
    <Hint
      label="Reset to default"
      render={
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Reset ${label} to default`}
          data-testid="setting-reset"
          className="size-5 text-muted-foreground hover:text-foreground"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onReset}
        />
      }
    >
      <Undo2 aria-hidden />
    </Hint>
  );
}

/**
 * A control that says why it is disabled when hovered or focused. A disabled button gets no
 * pointer or focus events of its own, so the reason hangs on a focusable wrapper around it. The
 * wrapper stays while the control is usable, so the control isn't remounted when the reason goes.
 */
export function WhyDisabled({
  reason,
  children,
}: {
  /** Absent while the control can be used. */
  reason: string | undefined;
  children: ReactNode;
}) {
  const off = reason === undefined;
  return (
    <Tooltip disabled={off}>
      <TooltipTrigger
        render={
          <span
            tabIndex={off ? undefined : 0}
            className="inline-flex max-w-full flex-wrap items-center justify-[inherit] gap-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        {children}
        {!off && <span className="sr-only">{reason}</span>}
      </TooltipTrigger>
      {!off && <TooltipContent>{reason}</TooltipContent>}
    </Tooltip>
  );
}

/** An error under the setting it belongs to. A long one is clamped to three lines until opened. */
export function ExpandableError({ message }: { message: string }) {
  const [open, setOpen] = useState(false);
  const long = isLongError(message);
  return (
    <div role="alert" className="flex flex-col items-start gap-0.5 text-meta text-destructive">
      <p className={cn("wrap-anywhere whitespace-pre-line", long && !open && "line-clamp-3")}>
        {message}
      </p>
      {long && (
        <button
          type="button"
          className="rounded-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={() => setOpen((was) => !was)}
        >
          {open ? "Show less" : "Show full error"}
        </button>
      )}
    </div>
  );
}

/**
 * A segmented control's track: a `surface-hover` fill the selected segment's `SEGMENT_SLAB` sits
 * on, so the selection shows on a card or popover as well as on the page.
 */
export const SEGMENT_TRACK = "isolate flex gap-0.5 rounded-lg bg-accent p-0.5";

/**
 * A row of choices, framed as one control; right-aligned when it wraps on a `SettingRow`. As wide
 * as its choices: under a field's name the track otherwise ran the card's width, mostly empty.
 */
export const OPTION_GROUP = `${SEGMENT_TRACK} w-fit max-w-full flex-wrap @min-[32rem]/row:justify-end`;

/**
 * A ghost Button as one segment of a row whose selection is a sliding `SegmentSlab`: unselected
 * labels are muted and brighten under the pointer without a tint, and the selected one takes the
 * foreground over its slab.
 */
export const SEGMENT =
  "relative text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent aria-checked:text-foreground aria-pressed:text-foreground";

/**
 * The selected segment's slab: the one selected style (`choice-selected`), an accent-tinted fill
 * with an accent edge, so a pick reads the same in Settings, New and the first run.
 */
export const SEGMENT_SLAB = "choice-selected";

/**
 * A settings segment's size: a full 32 px target with room either side of its word, since these are
 * the choices a page is mostly changed through.
 */
export const SEGMENT_ROOMY = "h-8 px-3";

/** One of an `OptionGroup`'s choices. */
export interface OptionGroupOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /**
   * One line on what picking it does: words, as it is also the choice's `aria-description`. When
   * any choice has one, the group draws its choices as cards, side by side where the column has
   * room (26 rem, as New workspace's column has) and one above the next where it hasn't, the line under each name.
   */
  readonly description?: string;
  readonly testId?: string;
}

/**
 * One choice out of a few, as a row of radio buttons: a segmented control of short words, or,
 * where the choices carry a `description`, a row of choice cards as New's autonomy has, the pick
 * with its check beside its name so it never shows by colour alone. Either way it is one Tab stop,
 * and the arrow keys, Home and End move the pick, as radios do.
 */
export function OptionGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  className,
}: {
  label: string;
  options: readonly OptionGroupOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** On the group's outermost element. */
  className?: string;
}) {
  const slab = useId();
  const cards = options.some((option) => option.description !== undefined);
  const radios = useRovingRadios(options, value, onChange);
  if (cards)
    return (
      <div className={cn("@container/options w-full", className)}>
        <div
          role="radiogroup"
          aria-label={label}
          onKeyDown={disabled ? undefined : radios.onKeyDown}
          className={cn(
            SEGMENT_TRACK,
            "grid grid-cols-1 @min-[26rem]/options:auto-cols-fr @min-[26rem]/options:grid-flow-col",
          )}
        >
          {options.map((option) => {
            const checked = option.value === value;
            return (
              <button
                key={option.value}
                {...radios.itemProps(option.value)}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={option.label}
                {...(option.description === undefined
                  ? {}
                  : { "aria-description": option.description })}
                data-testid={option.testId}
                disabled={disabled}
                className={CHOICE_CARD}
              >
                {checked && <SegmentSlab group={slab} className={SEGMENT_SLAB} />}
                <span className="flex w-full items-center gap-1.5 text-reading font-medium">
                  {option.label}
                  <ChoiceCheck checked={checked} className="ml-auto" />
                </span>
                {option.description !== undefined && (
                  <span className="text-meta text-muted-foreground">{option.description}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={disabled ? undefined : radios.onKeyDown}
      className={cn(OPTION_GROUP, className)}
    >
      {options.map((option) => (
        <Button
          key={option.value}
          {...radios.itemProps(option.value)}
          size="sm"
          role="radio"
          aria-checked={option.value === value}
          variant="ghost"
          className={cn(SEGMENT, SEGMENT_ROOMY)}
          data-testid={option.testId}
          disabled={disabled}
        >
          {option.value === value && <SegmentSlab group={slab} className={SEGMENT_SLAB} />}
          {option.label}
        </Button>
      ))}
    </div>
  );
}

const STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

function useRovingRadios<T extends string>(
  options: readonly { readonly value: T }[],
  value: T | undefined,
  onChange: (value: T) => void,
) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const stop = options.some((option) => option.value === value) ? value : options[0]?.value;
  const pick = (next: T) => {
    if (next !== value) onChange(next);
  };
  return {
    itemProps: (choice: T) => ({
      ref: (element: HTMLButtonElement | null) => {
        if (element) buttons.current.set(choice, element);
        else buttons.current.delete(choice);
      },
      tabIndex: choice === stop ? 0 : -1,
      onClick: () => pick(choice),
    }),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const at = options.findIndex((option) => buttons.current.get(option.value) === event.target);
      if (at === -1 || options.length === 0) return;
      const last = options.length - 1;
      const to =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : STEP[event.key] === undefined
              ? undefined
              : (at + STEP[event.key]! + options.length) % options.length;
      if (to === undefined) return;
      event.preventDefault();
      const next = options[to]!.value;
      buttons.current.get(next)?.focus();
      pick(next);
    },
  };
}

/** An on/off setting: a row with a switch on the right. */
export function Toggle({
  keywords,
  checked,
  onChange,
  disabled = false,
  disabledReason,
  onReset,
  error,
  detail,
  learnMore,
  nested = false,
  testId,
  ...name
}: RichLabel & {
  /** Extra words Settings search finds this by. */
  keywords?: readonly string[];
  /** On the row, for specs to find it by. */
  testId?: string;
  /** A part of the switch above it; see `SettingRow`. */
  nested?: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Why it's disabled, while it is. */
  disabledReason?: string | undefined;
  onReset?: (() => void) | undefined;
  error?: string | undefined;
  /** Under the row, such as what the setting turns on. */
  detail?: ReactNode;
  /** What the one line leaves out, in the same help. */
  learnMore?: ReactNode;
}) {
  const id = useId();
  return (
    <SettingRow
      {...name}
      htmlFor={id}
      testId={testId}
      {...(keywords === undefined ? {} : { keywords })}
      onReset={onReset}
      error={error}
      disabledReason={disabled ? disabledReason : undefined}
      detail={detail}
      learnMore={learnMore}
      nested={nested}
    >
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next)}
      />
    </SettingRow>
  );
}

/**
 * A number typed freely and saved on blur or Enter. What's typed stays a local draft until then, so
 * a half-typed "1" on the way to "12" is never saved; a draft that isn't a number in range snaps
 * back to the stored value.
 */
export function NumberField({
  label,
  description,
  keywords,
  value,
  onCommit,
  min,
  step = 1,
  prefix,
  disabled = false,
}: {
  label: string;
  description?: string;
  /** Extra words Settings search finds this by. */
  keywords?: readonly string[];
  value: number;
  onCommit: (value: number) => void;
  min: number;
  /** A whole `step` means whole numbers only. */
  step?: number;
  /** A unit shown ahead of the input, such as "$". */
  prefix?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = useId();
  const [draft, setDraft] = useState<string>();
  const dirty = draft !== undefined && draft !== String(value);
  const commit = () => {
    if (draft === undefined) return;
    const next = parseNumberDraft(draft, { min, integer: Number.isInteger(step) });
    setDraft(undefined);
    if (next !== undefined && next !== value) {
      const before = value;
      offerUndo(id, () => onCommit(before));
      onCommit(next);
    }
  };
  return (
    <Field
      label={label}
      htmlFor={id}
      {...(description === undefined ? {} : { description })}
      {...(keywords === undefined ? {} : { keywords })}
      hint={dirty ? <SaveHint id={hintId} /> : undefined}
      undoKey={id}
    >
      <span className="flex items-center gap-1">
        {prefix !== undefined && (
          <span aria-hidden className="text-muted-foreground">
            {prefix}
          </span>
        )}
        <input
          id={id}
          type="number"
          inputMode={Number.isInteger(step) ? "numeric" : "decimal"}
          min={min}
          step={step}
          disabled={disabled}
          className={cn(inputCls, "max-w-28 tabular-nums")}
          value={draft ?? String(value)}
          aria-describedby={dirty ? hintId : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            dropUndo(id);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) flushSync(commit);
            if (event.key === "Escape") setDraft(undefined);
          }}
        />
        {dirty && (
          <DraftActions label={label} onSave={commit} onCancel={() => setDraft(undefined)} />
        )}
      </span>
    </Field>
  );
}
