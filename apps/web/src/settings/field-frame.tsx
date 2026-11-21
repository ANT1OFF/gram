import type { HTMLAttributes, ReactNode } from "react";

import { HelpTip, SettingDescription } from "./help-tip";

/**
 * A setting's name, its ⓘ for what the description leaves out, what sits beside them, such as the
 * reset and "Saved", and the one line of description under them.
 */
export function RowLabel({
  label,
  labelText,
  htmlFor,
  description,
  learnMore,
  children,
}: {
  label: ReactNode;
  labelText: string;
  htmlFor: string | undefined;
  description: ReactNode;
  learnMore: ReactNode;
  /** After the name, on its line. */
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-h-5 items-center gap-1">
        {htmlFor === undefined ? (
          <span data-setting-label="" className="font-medium">
            {label}
          </span>
        ) : (
          <label data-setting-label="" htmlFor={htmlFor} className="font-medium">
            {label}
          </label>
        )}
        <HelpTip label={labelText} help={learnMore} />
        {children}
      </div>
      {description !== undefined && <SettingDescription>{description}</SettingDescription>}
    </div>
  );
}

/**
 * A setting's name and line may be rich (a link, a code span, a badge beside the words). Settings
 * search, the reset's and the ⓘ's names need their words: a string is its own, and a name that
 * isn't one must give them in `labelText`.
 */
export type RichLabel = { description?: ReactNode } & (
  | { label: string; labelText?: string | undefined }
  | {
      label: Exclude<ReactNode, string>;
      /** The name's words: Settings search, the reset's name and the ⓘ use them. */
      labelText: string;
    }
);

export const wordsOf = ({
  label,
  labelText,
  description,
}: {
  label: ReactNode;
  labelText?: string | undefined;
  description?: ReactNode;
}) => ({
  label: labelText ?? (typeof label === "string" ? label : ""),
  description: typeof description === "string" ? description : undefined,
});

/** A field's props: its name, an optional line under it, and its control. */
export type FieldProps = RichLabel & {
  /** On the field, for specs to find it by. */
  testId?: string;
  /** The control's id, when it's a single form element the label should name. */
  htmlFor?: string;
  /** What the one line leaves out, behind the ⓘ beside the name. */
  learnMore?: ReactNode;
  /** On the label's line, at its end. */
  action?: ReactNode;
  /**
   * Under the control: such as how to keep a draft not saved yet. Kept off the name's line, which
   * holds only the name and "Saved".
   */
  hint?: ReactNode;
  children: ReactNode;
};

/** A field's markup, with what a form of Settings' adds: the root's props and "Saved". */
export function FieldLayout({
  label,
  labelText,
  description,
  htmlFor,
  learnMore,
  action,
  hint,
  testId,
  rootProps,
  receipt,
  children,
}: FieldProps & {
  rootProps?: HTMLAttributes<HTMLDivElement>;
  /** On the name's line, after it: "Saved". */
  receipt?: ReactNode;
}) {
  const words = wordsOf({ label, labelText, description });
  return (
    <div {...rootProps} data-setting="" data-testid={testId} className="flex flex-col gap-1.5">
      <div className="flex items-start gap-1">
        <RowLabel
          label={label}
          labelText={words.label}
          htmlFor={htmlFor}
          description={description}
          learnMore={learnMore}
        >
          {receipt}
        </RowLabel>
        {action !== undefined && <div className="ms-auto flex items-center">{action}</div>}
      </div>
      {children}
      {hint}
    </div>
  );
}

/**
 * A labelled field: its name and one line of description, then the control below. Settings' own
 * `Field`, without its search and its "Saved", for a form that isn't a page of settings.
 */
export function Field(props: FieldProps) {
  return <FieldLayout {...props} />;
}
