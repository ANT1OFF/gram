import { Send } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { RecommendedTag } from "@/components/recommended-tag";
import { Button } from "@/components/ui/button";
import { shortcutHint } from "@/keyboard/bindings";
import { cn } from "@/lib/utils";

import { answerRule, choiceLayout, type AskOption } from "./ask-model";

// An ask's options and its longer words, as the ask stack and Quiet show them: every
// option whole, whatever its length or number, and words past their lines one click away.

/** The key that answers, beside what it answers. */
export function Kbd({
  children,
  className,
  hidden = false,
}: {
  children: ReactNode;
  className?: string;
  /** Kept out of the accessible name of what it sits in: a button's or a label's. */
  hidden?: boolean;
}) {
  return (
    <kbd
      data-testid="ask-kbd"
      aria-hidden={hidden || undefined}
      className={cn(
        "rounded-2xs border border-border-strong/60 px-1 font-mono text-caption leading-4 text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** The plain key that picks the option at `index`: its number. */
export const plainHint = (index: number): string | undefined =>
  index > 8 ? undefined : String(index + 1);

/**
 * The key an option shows, focus being on nothing that types: an approval's verb its shortcut's (the
 * thread card's, 1, 2 or 3 unless rebound; none once it is turned off), any other its number.
 */
export const optionHint = (
  option: Pick<AskOption, "shortcut"> | undefined,
  index: number,
): string | undefined =>
  option?.shortcut === undefined ? plainHint(index) : shortcutHint(option.shortcut) || undefined;

const CLAMP = { 2: "line-clamp-2", 3: "line-clamp-3" } as const;

/** Words shown in `lines` lines, with More for the rest once they run past them. */
export function MoreText({
  text,
  lines,
  className,
  testId,
}: {
  text: string;
  lines: keyof typeof CLAMP;
  className?: string;
  testId: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  // Whether the words run past their lines: after every render, as new words may, and on a resize.
  const measure = () => {
    const element = ref.current;
    if (element !== null && !open) setClipped(element.scrollHeight > element.clientHeight + 1);
  };
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || open || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      setClipped(element.scrollHeight > element.clientHeight + 1),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);
  return (
    <div className={className}>
      <p
        ref={ref}
        data-testid={testId}
        data-open={open || undefined}
        className={cn("break-words whitespace-pre-line", !open && CLAMP[lines])}
      >
        {text}
      </p>
      {(clipped || open) && (
        <button
          type="button"
          data-testid={`${testId}-more`}
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className="rounded-sm text-foreground/80 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

/** A choice's radio mark: a ring, filled with the accent once it is picked. */
function RadioMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-[calc((1lh-0.875rem)/2)] grid size-3.5 shrink-0 place-items-center rounded-full border transition-colors duration-(--dur-fast)",
        checked ? "border-primary" : "border-muted-foreground/60",
      )}
    >
      {checked && <span className="size-1.5 rounded-full bg-primary" />}
    </span>
  );
}

/** "Other…": an answer in the user's own words, offered after a question's choices. */
export interface OtherAnswer {
  /** What is typed so far. */
  readonly value: string;
  readonly onChange: (text: string) => void;
  /** Enter in the field: send what is typed. */
  readonly onSend: () => void;
  readonly inputRef?: ((element: HTMLInputElement | null) => void) | undefined;
  /** The question, for the field's name. */
  readonly question: string;
}

/**
 * The last of a question's choices: a radio like the others, with a field for the user's own words.
 * Typing in it, or focusing it, picks it; Enter sends what is typed.
 */
function OtherChoice({
  other,
  index,
  checked,
  hint,
  size,
  testId,
  onPick,
}: {
  other: OtherAnswer;
  index: number;
  checked: boolean;
  hint: string | undefined;
  size: "sm" | "default";
  testId: string;
  onPick: (index: number) => void;
}) {
  const field = useRef<HTMLInputElement | null>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing)
      return;
    event.preventDefault();
    // Handled here, so the surface's own ⌘⏎ doesn't send it a second time.
    event.stopPropagation();
    if (other.value.trim() !== "") other.onSend();
  };
  return (
    <div
      data-testid={`${testId}-other`}
      data-picked={checked || undefined}
      className={cn(
        "flex w-full min-w-0 items-start gap-2 rounded-(--radius-md) border px-2.5 transition-colors duration-(--dur-fast) focus-within:ring-2 focus-within:ring-ring @2xl:col-span-2",
        size === "sm" ? "py-1" : "py-1.5",
        checked ? "border-primary bg-primary/8" : "border-edge-action hover:bg-muted",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label="Other"
        data-choice-index={index}
        className="flex shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          onPick(index);
          field.current?.focus();
        }}
      >
        <RadioMark checked={checked} />
      </button>
      <input
        ref={(element) => {
          field.current = element;
          other.inputRef?.(element);
        }}
        type="text"
        data-testid={`${testId}-other-input`}
        aria-label={`Other answer: ${other.question}`}
        placeholder="Other…"
        value={other.value}
        onFocus={() => {
          if (!checked) onPick(index);
        }}
        onChange={(event) => {
          other.onChange(event.target.value);
          if (!checked) onPick(index);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "min-w-0 flex-1 bg-transparent leading-[inherit] outline-none placeholder:text-muted-foreground",
          size === "sm" ? "text-body" : "text-reading",
        )}
      />
      {hint !== undefined && <Kbd className="mt-0.5 shrink-0">{hint}</Kbd>}
    </div>
  );
}

/**
 * Send answer: what sends a picked choice, on every surface. `hint` is the key that presses it
 * (⌘⏎), shown when keys reach it. While it can't send, `title` says why in words beside it ("Pick
 * an answer"): a disabled button takes no hover, so a tooltip would never show.
 */
export function SendAnswer({
  disabled,
  hint,
  onSend,
  testId,
  size = "sm",
  label = "Send answer",
  title,
  type = "button",
  form,
}: {
  disabled: boolean;
  hint?: string | undefined;
  onSend?: (() => void) | undefined;
  testId: string;
  size?: "xs" | "sm" | "default";
  label?: string;
  title?: string | undefined;
  type?: "button" | "submit";
  /** The form a submit button sends, when it sits outside that form. */
  form?: string | undefined;
}) {
  const whyId = useId();
  const why = disabled && title !== undefined && title !== "" ? title : undefined;
  return (
    <>
      <Button
        type={type}
        form={form}
        size={size}
        data-testid={testId}
        data-send-answer
        disabled={disabled}
        title={why === undefined ? title : undefined}
        aria-describedby={why === undefined ? undefined : whyId}
        onClick={onSend}
      >
        <Send data-icon="inline-start" />
        {label}
        {hint !== undefined && (
          <Kbd hidden className="border-current/40 text-current">
            {hint}
          </Kbd>
        )}
      </Button>
      {why !== undefined && (
        <span
          id={whyId}
          data-testid="send-answer-why"
          // Why Send waits stays on one line beside it: what is left of the row gives way first.
          className="shrink-0 text-meta whitespace-nowrap text-muted-foreground"
        >
          {why}
        </span>
      )}
    </>
  );
}

/**
 * An ask's options, by its answer rule (`answerRule`). A question's choices are radios: a click or
 * a number key picks one (`picked`), and Send answer, beside them, sends it. An approval's verbs
 * are buttons that act on a click. A few short ones sit in a wrapping row; many, long or described
 * ones in a list, one a line with its description under it. `hintOf` gives the key that picks
 * each, when keys reach the ask. The asker's own pick carries a Recommended tag, never a look of
 * being chosen. With `other`, a question's choices end with "Other…", picked as the index after
 * the last option, and are always a list.
 */
export function AskChoices({
  options,
  hintOf,
  onChoose,
  picked,
  onPick,
  testId,
  size = "sm",
  rest = "outline",
  className,
  children,
  other,
}: {
  options: readonly AskOption[];
  hintOf: (index: number) => string | undefined;
  /** What a click on a verb does: it acts. */
  onChoose: (option: AskOption) => void;
  /** The picked choice's index, for a question. */
  picked?: number | undefined;
  /** What a click on a choice does: it picks. */
  onPick?: ((index: number) => void) | undefined;
  testId: string;
  size?: "sm" | "default";
  /** How the verbs after the first look in a row. */
  rest?: "ghost" | "outline";
  className?: string;
  /** What follows the choices in their row or under their list: Send answer. */
  children?: ReactNode;
  /** A question's answer in the user's own words, offered after its choices. */
  other?: OtherAnswer | undefined;
}) {
  if (options.length === 0) return null;
  const pickRule = answerRule(options) === "pick" && onPick !== undefined;
  // A field for words sits on a line of its own, so the choices before it do too.
  const layout = pickRule && other !== undefined ? "list" : choiceLayout(options);
  if (pickRule) {
    return (
      <div
        data-testid="ask-choices"
        data-layout={layout}
        data-rule="pick"
        className={cn(
          "@container min-w-0",
          layout === "row" && "flex flex-wrap items-center gap-1",
          className,
        )}
      >
        <div
          role="radiogroup"
          aria-label="Choices"
          className={cn(
            layout === "row"
              ? "flex flex-wrap items-center gap-1"
              : // Two to a line where there is room for both, so a wide stack stays short.
                "grid gap-1 @2xl:grid-cols-2",
          )}
        >
          {options.map((option, index) => {
            const hint = hintOf(index);
            const checked = picked === index;
            return (
              <button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={checked}
                data-testid={testId}
                data-choice-index={index}
                data-picked={checked || undefined}
                data-recommended={option.recommended || undefined}
                onClick={() => onPick(index)}
                className={cn(
                  "flex min-w-0 items-start gap-2 rounded-(--radius-md) border text-left outline-none transition-colors duration-(--dur-fast) focus-visible:ring-2 focus-visible:ring-ring",
                  layout === "row" ? "px-2" : "w-full px-2.5",
                  size === "sm" ? "py-1" : "py-1.5",
                  checked ? "border-primary bg-primary/8" : "border-edge-action hover:bg-muted",
                )}
              >
                <RadioMark checked={checked} />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span
                      className={cn(
                        "font-medium break-words",
                        size === "sm" ? "text-body" : "text-reading",
                      )}
                    >
                      {option.label}
                    </span>
                    {option.recommended === true && <RecommendedTag />}
                  </span>
                  {option.description !== undefined && (
                    <span
                      data-testid="ask-choice-description"
                      className="text-meta break-words text-muted-foreground"
                    >
                      {option.description}
                    </span>
                  )}
                </span>
                {hint !== undefined && <Kbd className="mt-0.5 shrink-0">{hint}</Kbd>}
              </button>
            );
          })}
          {other !== undefined && (
            <OtherChoice
              other={other}
              index={options.length}
              checked={picked === options.length}
              hint={hintOf(options.length)}
              size={size}
              testId={testId}
              onPick={onPick}
            />
          )}
        </div>
        {layout === "row"
          ? children
          : children !== undefined && (
              <div className="mt-1.5 flex items-center gap-2">{children}</div>
            )}
      </div>
    );
  }
  if (layout === "row") {
    return (
      <div
        data-testid="ask-choices"
        data-layout="row"
        data-rule="act"
        className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}
      >
        {options.map((option, index) => {
          const hint = hintOf(index);
          return (
            <Button
              key={option.label}
              size={size}
              variant={index === 0 ? "default" : rest}
              data-testid={testId}
              data-choice-index={index}
              data-picked={picked === index || undefined}
              data-recommended={option.recommended || undefined}
              aria-pressed={picked === undefined ? undefined : picked === index}
              onClick={() => onChoose(option)}
              className={cn(picked === index && "ring-2 ring-ring")}
            >
              {option.label}
              {option.recommended === true && <RecommendedTag />}
              {hint !== undefined && (
                <Kbd className={cn(index === 0 && "border-current/40 text-current")}>{hint}</Kbd>
              )}
            </Button>
          );
        })}
        {children}
      </div>
    );
  }
  return (
    <div
      data-testid="ask-choices"
      data-layout="list"
      data-rule="act"
      className={cn("@container min-w-0", className)}
    >
      <div role="group" aria-label="Choices" className="grid gap-1 @2xl:grid-cols-2">
        {options.map((option, index) => {
          const hint = hintOf(index);
          return (
            <button
              key={option.label}
              type="button"
              data-testid={testId}
              data-choice-index={index}
              data-picked={picked === index || undefined}
              data-recommended={option.recommended || undefined}
              aria-pressed={picked === undefined ? undefined : picked === index}
              onClick={() => onChoose(option)}
              className={cn(
                "flex w-full min-w-0 items-start gap-2 rounded-(--radius-md) border border-edge-action px-2.5 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                size === "sm" ? "py-1" : "py-1.5",
                picked === index && "ring-2 ring-ring",
              )}
            >
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                  <span
                    className={cn(
                      "font-medium break-words",
                      size === "sm" ? "text-body" : "text-reading",
                    )}
                  >
                    {option.label}
                  </span>
                  {option.recommended === true && <RecommendedTag />}
                </span>
                {option.description !== undefined && (
                  <span
                    data-testid="ask-choice-description"
                    className="text-meta break-words text-muted-foreground"
                  >
                    {option.description}
                  </span>
                )}
              </span>
              {hint !== undefined && <Kbd className="mt-0.5 shrink-0">{hint}</Kbd>}
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
}
