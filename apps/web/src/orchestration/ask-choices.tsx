import { Star } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { choiceLayout, type AskOption } from "./ask-model";

// An ask's options and its longer words, as the ask stack and Quiet show them: every
// option whole, whatever its length or number, and words past their lines one click away.

/** The key that answers, beside what it answers. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      data-testid="ask-kbd"
      className={cn(
        "rounded-sm border border-border/70 px-1 font-mono text-[10px] leading-4 text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** The plain key that picks the option at `index`: ⏎ for the first, then its number. */
export const plainHint = (index: number): string | undefined =>
  index > 8 ? undefined : index === 0 ? "⏎" : String(index + 1);

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

/** The asker's pick, marked beside its label. */
function RecommendedMark({ withWord }: { withWord: boolean }) {
  return (
    <span
      data-testid="ask-recommended"
      className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-normal text-status-needs"
    >
      <Star aria-hidden className="size-2.5 fill-current" />
      <span className={withWord ? undefined : "sr-only"}>Recommended</span>
    </span>
  );
}

/**
 * An ask's options: a few short ones as a wrapping row of buttons, the first one primary; many,
 * long or described ones as a list, one a line with its description under it. `hintOf` gives the
 * key that picks each, when keys reach the ask.
 */
export function AskChoices({
  options,
  hintOf,
  onChoose,
  testId,
  size = "sm",
  rest = "outline",
  className,
}: {
  options: readonly AskOption[];
  hintOf: (index: number) => string | undefined;
  onChoose: (option: AskOption) => void;
  testId: string;
  size?: "sm" | "default";
  /** How the options after the first look in a row. */
  rest?: "ghost" | "outline";
  className?: string;
}) {
  if (options.length === 0) return null;
  const layout = choiceLayout(options);
  if (layout === "row") {
    return (
      <div
        data-testid="ask-choices"
        data-layout="row"
        className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}
      >
        {options.map((option, index) => {
          const hint = hintOf(index);
          const props = {
            size,
            variant: index === 0 ? ("default" as const) : rest,
            "data-testid": testId,
            "data-recommended": option.recommended || undefined,
            onClick: () => onChoose(option),
          };
          const label = (
            <>
              {option.label}
              {option.recommended === true && <RecommendedMark withWord={false} />}
              {hint !== undefined && (
                <Kbd
                  className={cn(
                    index === 0 && "border-primary-foreground/30 text-primary-foreground/80",
                  )}
                >
                  {hint}
                </Kbd>
              )}
            </>
          );
          // Too little room in a row for the word: the star says it on hover and focus.
          return option.recommended === true ? (
            <Hint key={option.label} label="Recommended" render={<Button {...props} />}>
              {label}
            </Hint>
          ) : (
            <Button key={option.label} {...props}>
              {label}
            </Button>
          );
        })}
      </div>
    );
  }
  return (
    <div
      data-testid="ask-choices"
      data-layout="list"
      className={cn("@container min-w-0", className)}
    >
      {/* Two to a line where there is room for both, so a wide stack stays short. */}
      <div role="group" aria-label="Choices" className="grid gap-1 @2xl:grid-cols-2">
        {options.map((option, index) => {
          const hint = hintOf(index);
          return (
            <button
              key={option.label}
              type="button"
              data-testid={testId}
              data-recommended={option.recommended || undefined}
              onClick={() => onChoose(option)}
              className={cn(
                "flex w-full min-w-0 items-start gap-2 rounded-(--radius-md) border px-2.5 text-left outline-none transition-colors duration-(--dur-fast) focus-visible:ring-2 focus-visible:ring-ring",
                size === "sm" ? "py-1" : "py-1.5",
                // The one ⏎ takes stands out a little; the rest sit quiet until hovered.
                index === 0
                  ? "border-primary/45 bg-primary/8 hover:bg-primary/14"
                  : "border-border/70 hover:bg-muted",
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
                  {option.recommended === true && <RecommendedMark withWord />}
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
    </div>
  );
}
