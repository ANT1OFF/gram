import { Undo2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SegmentSlab } from "@/motion";

import { HelpTip } from "./help-tip";
import { isLongError } from "./long-error";
import { parseNumberDraft } from "./number-draft";
import { useSettingSearch } from "./search-scope";

export const inputCls =
  "h-8 w-full max-w-md rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** A text input on the right of a `SettingRow`: a fixed width, narrower when the row is. */
export const rowInputCls = cn(inputCls, "w-64 max-w-full");

/**
 * A setting is a label of four words or fewer and its control; what it does shows on the label's
 * hover or focus. `settings-copy.test.tsx` fails a page with a longer label or line. Text that has to be
 * read whole, such as a consent or a legal notice, carries this attribute, set to why, and is left
 * out of that count.
 */
export const LONG_COPY = "data-long-copy";

/**
 * A label's help: the one-line description and what it leaves out, together. Absent when there is
 * neither.
 */
function rowHelp(description: string | undefined, learnMore: ReactNode): ReactNode {
  if (learnMore === undefined || learnMore === null) return description;
  return (
    <>
      {description !== undefined && <p>{description}</p>}
      {learnMore}
    </>
  );
}

/** The name of a setting, which shows its help on hover or focus. */
function RowLabel({
  label,
  htmlFor,
  help,
}: {
  label: string;
  htmlFor: string | undefined;
  help: ReactNode;
}) {
  return (
    <HelpTip label={label} help={help}>
      {htmlFor === undefined ? (
        <span data-setting-label="" className="font-medium">
          {label}
        </span>
      ) : (
        <label data-setting-label="" htmlFor={htmlFor} className="font-medium">
          {label}
        </label>
      )}
    </HelpTip>
  );
}

/** A labelled setting in a form: its name, which explains it on hover or focus, then the control below. */
export function Field({
  label,
  description,
  keywords,
  htmlFor,
  learnMore,
  action,
  children,
}: {
  label: string;
  description?: string;
  /** Extra words Settings search finds this by. */
  keywords?: readonly string[];
  /** The control's id, when it's a single form element the label should name. */
  htmlFor?: string;
  /** What the one line leaves out, in the same help. */
  learnMore?: ReactNode;
  /** On the label's line, at its end. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const search = useSettingSearch({ label, description, keywords });
  return (
    <div {...search} data-setting="" className="flex flex-col gap-1.5">
      <div className="flex min-h-5 items-center gap-1">
        <RowLabel label={label} htmlFor={htmlFor} help={rowHelp(description, learnMore)} />
        {action !== undefined && <div className="ms-auto flex items-center">{action}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * One setting on one line of a `SettingsGroup` card: its name on the left, which explains it on
 * hover or focus, its control on the right, dropping below when the two don't fit side by side. `onReset` is
 * passed only while the value differs from its default, so the reset icon it shows also marks what
 * was changed.
 */
export function SettingRow({
  label,
  description,
  keywords,
  htmlFor,
  onReset,
  error,
  disabledReason,
  detail,
  learnMore,
  children,
}: {
  label: string;
  description?: string;
  /** Extra words Settings search finds this by. */
  keywords?: readonly string[];
  /** The control's id, when it's a single form element the label should name. */
  htmlFor?: string;
  /** What the one line leaves out, in the same help. */
  learnMore?: ReactNode;
  /** Puts the default back; absent while the value is the default. */
  onReset?: (() => void) | undefined;
  /** Why the last change to this setting failed, shown under the row. */
  error?: string | undefined;
  /** Why the control can't be used right now; set only while it is disabled. */
  disabledReason?: string | undefined;
  /** Full-width content under the row, such as a list the setting edits. */
  detail?: ReactNode;
  children?: ReactNode;
}) {
  const search = useSettingSearch({ label, description, keywords });
  return (
    <div {...search} data-setting="" className="@container/row flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_10rem] items-center gap-1">
          <RowLabel label={label} htmlFor={htmlFor} help={rowHelp(description, learnMore)} />
          {onReset && <ResetButton label={label} onReset={onReset} />}
        </div>
        {children !== undefined && (
          <div className="ms-auto flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">
            <WhyDisabled reason={disabledReason}>{children}</WhyDisabled>
          </div>
        )}
      </div>
      {detail}
      {error && <ExpandableError message={error} />}
    </div>
  );
}

/** The ↺ beside a changed setting's name. */
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
          // Keeps focus in a text field the click would otherwise blur, which saves its draft.
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
    <div role="alert" className="flex flex-col items-start gap-0.5 text-xs text-destructive">
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

/** A row of choices, framed as one control; right-aligned when it wraps on a `SettingRow`. */
export const OPTION_GROUP = `${SEGMENT_TRACK} flex-wrap @min-[32rem]/row:justify-end`;

/**
 * A ghost Button as one segment of a row whose selection is a sliding `SegmentSlab`: unselected
 * labels are muted and brighten under the pointer without a tint, and the selected one takes the
 * foreground over its slab.
 */
export const SEGMENT =
  "relative text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent aria-checked:text-foreground aria-pressed:text-foreground";

/**
 * The selected segment's slab: `surface-3` with a hairline. That fill is also a card's and a
 * popover's, so on one of them the track and the hairline are what set the slab apart.
 */
export const SEGMENT_SLAB = "bg-secondary ring-1 ring-border";

/** One choice out of a few, as a row of radio buttons. */
export function OptionGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: readonly { readonly value: T; readonly label: string }[];
  value: T | undefined;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const slab = useId();
  return (
    <div role="radiogroup" aria-label={label} className={OPTION_GROUP}>
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          role="radio"
          aria-checked={option.value === value}
          variant="ghost"
          className={SEGMENT}
          disabled={disabled}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.value === value && <SegmentSlab group={slab} className={SEGMENT_SLAB} />}
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** An on/off setting: a row with a switch on the right. */
export function Toggle({
  label,
  description,
  keywords,
  checked,
  onChange,
  disabled = false,
  disabledReason,
  onReset,
  error,
  detail,
  learnMore,
}: {
  label: string;
  description?: string;
  /** Extra words Settings search finds this by. */
  keywords?: readonly string[];
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
      label={label}
      htmlFor={id}
      {...(description === undefined ? {} : { description })}
      {...(keywords === undefined ? {} : { keywords })}
      onReset={onReset}
      error={error}
      disabledReason={disabled ? disabledReason : undefined}
      detail={detail}
      learnMore={learnMore}
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
  const [draft, setDraft] = useState<string>();
  const commit = () => {
    if (draft === undefined) return;
    const next = parseNumberDraft(draft, { min, integer: Number.isInteger(step) });
    setDraft(undefined);
    if (next !== undefined && next !== value) onCommit(next);
  };
  return (
    <Field
      label={label}
      htmlFor={id}
      {...(description === undefined ? {} : { description })}
      {...(keywords === undefined ? {} : { keywords })}
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
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            // The enclosing form or Create shortcut reads the committed value in this same event.
            if (event.key === "Enter" && !event.nativeEvent.isComposing) flushSync(commit);
            if (event.key === "Escape") setDraft(undefined);
          }}
        />
      </span>
    </Field>
  );
}
