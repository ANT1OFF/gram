import { Send } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { RecommendedTag } from "@/components/recommended-tag";
import { Button } from "@/components/ui/button";
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
        "rounded-sm border border-border/70 px-1 font-mono text-[10px] leading-4 text-muted-foreground",
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
        "mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-full border transition-colors duration-(--dur-fast)",
        checked ? "border-primary" : "border-muted-foreground/60",
      )}
    >
      {checked && <span className="size-1.5 rounded-full bg-primary" />}
    </span>
  );
}

/**
 * Send answer: what sends a picked choice, on every surface. `hint` is the key that presses it
 * (⌘⏎), shown when keys reach it.
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
}: {
  disabled: boolean;
  hint?: string | undefined;
  onSend?: (() => void) | undefined;
  testId: string;
  size?: "xs" | "sm" | "default";
  label?: string;
  title?: string | undefined;
  type?: "button" | "submit";
}) {
  return (
    <Button
      type={type}
      size={size}
      data-testid={testId}
      data-send-answer
      disabled={disabled}
      title={title}
      onClick={onSend}
    >
      <Send data-icon="inline-start" />
      {label}
      {hint !== undefined && (
        <Kbd hidden className="border-primary-foreground/30 text-primary-foreground/80">
          {hint}
        </Kbd>
      )}
    </Button>
  );
}

/**
 * An ask's options, by its answer rule (`answerRule`). A question's choices are radios: a click or
 * a number key picks one (`picked`), and Send answer, beside them, sends it. An approval's verbs
 * are buttons that act on a click. A few short ones sit in a wrapping row; many, long or described
 * ones in a list, one a line with its description under it. `hintOf` gives the key that picks
 * each, when keys reach the ask. The asker's own pick carries a Recommended tag, never a look of
 * being chosen.
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
}) {
  if (options.length === 0) return null;
  const layout = choiceLayout(options);
  if (answerRule(options) === "pick" && onPick !== undefined) {
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
                  checked ? "border-primary bg-primary/8" : "border-border/70 hover:bg-muted",
                )}
              >
                <RadioMark checked={checked} />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span
                      className={cn(
                        "font-medium break-words",
                        size === "sm" ? "text-[0.8rem]" : "text-sm",
                      )}
                    >
                      {option.label}
                    </span>
                    {option.recommended === true && <RecommendedTag />}
                  </span>
                  {option.description !== undefined && (
                    <span
                      data-testid="ask-choice-description"
                      className="text-xs break-words text-muted-foreground"
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
                <Kbd
                  className={cn(
                    index === 0 && "border-primary-foreground/30 text-primary-foreground/80",
                  )}
                >
                  {hint}
                </Kbd>
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
                "flex w-full min-w-0 items-start gap-2 rounded-(--radius-md) border border-border/70 px-2.5 text-left outline-none transition-colors duration-(--dur-fast) hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                size === "sm" ? "py-1" : "py-1.5",
                picked === index && "ring-2 ring-ring",
              )}
            >
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                  <span
                    className={cn(
                      "font-medium break-words",
                      size === "sm" ? "text-[0.8rem]" : "text-sm",
                    )}
                  >
                    {option.label}
                  </span>
                  {option.recommended === true && <RecommendedTag />}
                </span>
                {option.description !== undefined && (
                  <span
                    data-testid="ask-choice-description"
                    className="text-xs break-words text-muted-foreground"
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
