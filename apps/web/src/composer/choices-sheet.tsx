import { Drawer } from "@base-ui/react/drawer";
import { CheckIcon, X } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import type { ChoiceOption, ChoiceSection } from "./choices";

/**
 * The choices chip's words on a phone, where there is no hover to say them: the model, the effort
 * when not left to the model, the mode, and Fast when on, "Opus · High · Auto". The agent's mark
 * beside them names the agent, so the model drops its "Claude ".
 */
export function chipWords(sections: readonly ChoiceSection[]): string {
  const words = sections.flatMap((section) => {
    if (section.unavailable !== undefined || section.value === undefined) return [];
    const chosen = section.options?.find((option) => option.value === section.value);
    switch (section.id) {
      case "model":
        return [(chosen?.compact ?? section.named).replace(/^Claude /, "")];
      case "effort":
        return section.value === "default"
          ? []
          : [chosen?.compact ?? chosen?.short ?? section.named];
      case "speed":
        return section.value === "fast" ? ["Fast"] : [];
      default:
        return [chosen?.compact ?? section.named];
    }
  });
  return words.join(" · ");
}

/**
 * The composer's choices on a phone: a sheet from the bottom in place of the desktop's popover,
 * with the same sections and the same writes. The model's rows each say a line on it, effort and
 * mode are segments, and speed is Fast's switch. A pick doesn't close it, so a model and its effort
 * can be set together; the scrim, Escape, a swipe down or Close does.
 */
export function ChoicesSheet({
  sections,
  onPick,
}: {
  sections: readonly ChoiceSection[];
  onPick: (section: ChoiceSection, option: ChoiceOption) => void;
}) {
  return (
    <Drawer.Portal>
      <Drawer.Backdrop className="fixed inset-0 z-50 scrim opacity-[calc(1-var(--drawer-swipe-progress,0))] transition-opacity duration-(--dur-base) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-swiping:duration-0" />
      <Drawer.Viewport className="fixed inset-0 z-50 flex items-end justify-center">
        <Drawer.Popup
          data-surface="overlay"
          data-testid="composer-choices-popup"
          className="flex max-h-[85dvh] w-full max-w-xl translate-y-(--drawer-swipe-movement-y,0) flex-col rounded-t-xl border-t border-edge bg-popover pb-[env(safe-area-inset-bottom,0px)] text-popover-foreground shadow-overlay outline-none transition-transform duration-(--dur-move-base) ease-out data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full data-swiping:select-none"
        >
          <div
            aria-hidden
            className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border-strong"
          />
          <div className="flex shrink-0 items-center pr-1 pl-4">
            <Drawer.Title className="min-w-0 flex-1 truncate font-heading text-title">
              Model and mode
            </Drawer.Title>
            <Drawer.Close
              aria-label="Close"
              data-testid="composer-choices-close"
              className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:focus-ring"
            >
              <X aria-hidden className="size-icon-bar" />
            </Drawer.Close>
          </div>
          <Drawer.Content className="flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain px-4 pb-6">
            {sections.map((section) => (
              <SheetSection
                key={section.id}
                section={section}
                onPick={(option) => onPick(section, option)}
              />
            ))}
          </Drawer.Content>
        </Drawer.Popup>
      </Drawer.Viewport>
    </Drawer.Portal>
  );
}

function SheetSection({
  section,
  onPick,
}: {
  section: ChoiceSection;
  onPick: (option: ChoiceOption) => void;
}) {
  const options = section.options ?? [];
  const headingId = `choices-sheet-${section.id}`;
  let body: ReactNode;
  if (section.unavailable !== undefined)
    body = <p className="text-meta text-muted-foreground">{section.unavailable}</p>;
  else if (section.body !== undefined) body = section.body;
  else if (section.id === "model") body = <ModelRows section={section} onPick={onPick} />;
  else if (section.id === "speed") body = <FastSwitch section={section} onPick={onPick} />;
  else body = <Segments section={section} headingId={headingId} onPick={onPick} />;
  const chosen = options.find((option) => option.value === section.value);
  return (
    <section
      aria-labelledby={headingId}
      data-choice-section={section.id}
      className={cn(
        "flex flex-col gap-1.5 pt-3",
        section.unavailable !== undefined && "opacity-60",
      )}
    >
      <h3
        id={headingId}
        data-testid={`choices-${section.id}`}
        className="text-meta text-muted-foreground"
      >
        {section.label}
      </h3>
      {body}
      {section.id === "model" && section.warning !== undefined && (
        <p className="text-meta text-warning">{section.warning}</p>
      )}
      {/* What the chosen effort or mode does, the line a desktop row says under its label. */}
      {section.unavailable === undefined &&
        section.id !== "model" &&
        section.id !== "speed" &&
        chosen?.description !== undefined && (
          <p className={cn("text-meta text-muted-foreground", section.warning && "text-warning")}>
            {chosen.description}
          </p>
        )}
    </section>
  );
}

/** The models, a row each with its line under the name and a check on the current one. */
function ModelRows({
  section,
  onPick,
}: {
  section: ChoiceSection;
  onPick: (option: ChoiceOption) => void;
}) {
  const options = section.options ?? [];
  const heads = section.search?.heads;
  return (
    <div role="listbox" aria-label={section.label} className="flex flex-col">
      {options.map((option, index) => {
        const selected = option.value === section.value;
        const icon = option.icon ?? section.search?.rowIcon;
        // Another agent's group starts with its mark and, with no hover here, its words.
        const head =
          option.group !== undefined &&
          option.group !== options[index - 1]?.group &&
          index > 0 &&
          heads?.[option.group] !== undefined
            ? heads[option.group]
            : undefined;
        return (
          <Fragment key={option.value}>
            {head !== undefined && (
              <div
                role="presentation"
                data-testid="model-group-head"
                className="flex items-center gap-2 border-t border-border px-1 pt-3 pb-1 text-meta text-muted-foreground"
              >
                <span aria-hidden className="flex shrink-0 items-center">
                  {head.mark}
                </span>
                {head.hint}
              </div>
            )}
            <button
              type="button"
              role="option"
              aria-selected={selected}
              aria-disabled={option.disabled || undefined}
              data-choice-row
              onClick={() => onPick(option)}
              className={cn(
                "flex min-h-13 w-full items-center gap-3 border-b border-border px-1 py-1.5 text-left outline-none last:border-b-0 focus-visible:focus-ring-inset",
                option.disabled && "pointer-events-none opacity-50",
              )}
            >
              {icon !== undefined && (
                <span aria-hidden className="flex shrink-0 items-center text-muted-foreground">
                  {icon}
                </span>
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-reading font-medium">{option.label}</span>
                {option.description !== undefined && (
                  <span className="truncate text-meta text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
              {selected && <CheckIcon aria-hidden className="size-icon-row shrink-0 text-link" />}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Effort or mode as one row of segments, the chosen one raised. */
function Segments({
  section,
  headingId,
  onPick,
}: {
  section: ChoiceSection;
  headingId: string;
  onPick: (option: ChoiceOption) => void;
}) {
  const options = section.options ?? [];
  return (
    <div
      role="radiogroup"
      aria-labelledby={headingId}
      className="grid grid-flow-col auto-cols-fr gap-0.5 rounded-lg border border-border p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === section.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.short ?? option.label}
            disabled={option.disabled}
            data-choice-row
            onClick={() => onPick(option)}
            className={cn(
              "flex min-h-10 min-w-0 items-center justify-center rounded-md px-1 text-meta text-muted-foreground outline-none focus-visible:focus-ring-inset disabled:opacity-50",
              selected && "choice-selected font-medium",
              selected && section.warning && "text-warning",
            )}
          >
            {option.icon !== undefined && (
              <span aria-hidden className="mr-1 flex shrink-0 items-center">
                {option.icon}
              </span>
            )}
            <span className="truncate">
              {option.word ?? option.compact ?? option.short ?? option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Speed as Fast's switch: on picks Fast, off Standard; greyed where the model has no Fast. */
function FastSwitch({
  section,
  onPick,
}: {
  section: ChoiceSection;
  onPick: (option: ChoiceOption) => void;
}) {
  const options = section.options ?? [];
  const fast = options.find((option) => option.value === "fast");
  const standard = options.find((option) => option.value === "standard");
  const on = section.value === "fast";
  const offered = fast !== undefined && !fast.disabled;
  const id = "choices-sheet-fast";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-11 items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span id={id} className="text-reading font-medium">
            Fast mode
          </span>
          <span className="text-meta text-muted-foreground">
            {offered || on ? section.named : "Not offered for this model."}
          </span>
        </span>
        <Switch
          aria-labelledby={id}
          data-testid="choices-fast-switch"
          checked={on}
          disabled={!offered && !on}
          onCheckedChange={(next) => {
            const option = next ? fast : standard;
            if (option) onPick(option);
          }}
          className="relative h-6.5 w-11 after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-[''] [&>[data-slot=switch-thumb]]:size-5.5 [&>[data-slot=switch-thumb]]:data-checked:translate-x-[calc(100%-3px)]"
        />
      </div>
      {/* What Fast costs, only where it can be had. */}
      {(offered || on) &&
        section.notes?.map((note) => (
          <p key={note} className="text-meta text-muted-foreground">
            {note}
          </p>
        ))}
    </div>
  );
}
