import { useId, useState } from "react";

import { cn } from "@/lib/utils";

import { inputCls } from "./input";

/** `#rgb` or `#rrggbb`, with or without the `#`, as lowercase `#rrggbb`; undefined if not one. */
export function parseHex(text: string): string | undefined {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!match) return undefined;
  const digits = match[1]!.toLowerCase();
  return `#${digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits}`;
}

/**
 * A colour as a hex code: a swatch that opens the system's colour picker, the code in a monospace
 * field and, when given, preset `swatches` to pick from. The field takes `#rgb` or `#rrggbb` and
 * commits it as lowercase `#rrggbb` on Enter or when it loses focus; anything else is marked
 * invalid until it is fixed, and Escape puts back the value. `onChange` only ever gets a valid code.
 */
export function ColorField({
  value,
  onChange,
  label,
  swatches,
  invalid = false,
  disabled = false,
  id,
  className,
  testId,
}: {
  /** `#rrggbb`. */
  value: string;
  onChange: (value: string) => void;
  /** The colour's name ("Accent"): the field's and the swatch's accessible name. */
  label?: string | undefined;
  /** Colours offered beside the field, each `#rgb` or `#rrggbb`. */
  swatches?: readonly string[] | undefined;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
  /** The text field's id, for a `<label htmlFor>` of the host's. */
  id?: string | undefined;
  className?: string | undefined;
  testId?: string | undefined;
}) {
  const ownId = useId();
  const fieldId = id ?? ownId;
  const current = parseHex(value);
  const [draft, setDraft] = useState(value);
  const [draftOf, setDraftOf] = useState(value);
  if (draftOf !== value) {
    setDraftOf(value);
    setDraft(value);
  }
  const bad = parseHex(draft) === undefined;
  const name = label ?? "Colour";

  const commit = () => {
    const parsed = parseHex(draft);
    if (parsed === undefined) return;
    setDraft(parsed);
    if (parsed !== current) onChange(parsed);
  };

  const presets = [...new Set((swatches ?? []).flatMap((swatch) => parseHex(swatch) ?? []))];

  return (
    <div
      data-slot="color-field"
      className={cn("flex flex-wrap items-center gap-2", className)}
      data-testid={testId}
    >
      <span
        className={cn(
          "relative size-8 shrink-0 rounded-lg border border-input has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
          disabled && "opacity-50",
        )}
        style={{ backgroundColor: current ?? "transparent" }}
      >
        <input
          type="color"
          aria-label={`${name}: pick a colour, now ${current ?? "none"}`}
          value={current ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const parsed = parseHex(event.target.value);
            if (parsed !== undefined && parsed !== current) onChange(parsed);
          }}
          className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
      </span>
      <input
        id={fieldId}
        type="text"
        {...(id === undefined ? { "aria-label": name } : {})}
        {...(invalid || bad ? { "aria-invalid": true } : {})}
        value={draft}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        maxLength={9}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape" && draft !== value) {
            event.preventDefault();
            event.stopPropagation();
            setDraft(value);
          }
        }}
        className={cn(
          inputCls,
          "w-28 font-mono disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/30",
        )}
      />
      {presets.length > 0 && (
        <span role="group" aria-label={`${name}: presets`} className="flex flex-wrap gap-1">
          {presets.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={swatch}
              aria-pressed={swatch === current}
              disabled={disabled}
              onClick={() => swatch !== current && onChange(swatch)}
              className="size-6 rounded-md border border-input outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:ring-2 aria-pressed:ring-foreground aria-pressed:ring-offset-1 aria-pressed:ring-offset-background"
              style={{ backgroundColor: swatch }}
            />
          ))}
        </span>
      )}
    </div>
  );
}
