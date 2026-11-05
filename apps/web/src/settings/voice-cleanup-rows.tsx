import {
  DEFAULT_SETTINGS,
  dictationCleanupOf,
  type Settings,
  type VoiceSettings,
} from "@gram/contracts";

import { Toggle } from "./fields";

type CleanupPatch = Pick<VoiceSettings, "removeFillers" | "spokenFormatting" | "spokenSymbols">;

/**
 * The switches for the clean-up each committed utterance gets (`dictation/postprocess.ts`), one
 * per group of rules. The live words at the caret are never cleaned up, only what commits.
 */
export function VoiceCleanupRows({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (patch: CleanupPatch) => void;
}) {
  const cleanup = dictationCleanupOf(settings);
  const initial = dictationCleanupOf(DEFAULT_SETTINGS);
  /** A reset back to `value` while the switch differs from it. */
  const resetTo = (now: boolean, value: boolean, patch: CleanupPatch) =>
    now === value ? undefined : () => onChange(patch);
  return (
    <>
      <Toggle
        label="Remove filler words"
        description={`Drops "um", "uh", "erm" and the like. Real words such as "like" stay.`}
        keywords={["filler", "um", "uh", "clean up", "hesitation"]}
        checked={cleanup.fillers}
        onReset={resetTo(cleanup.fillers, initial.fillers, { removeFillers: initial.fillers })}
        onChange={(next) => onChange({ removeFillers: next })}
      />
      <Toggle
        label="Spoken formatting"
        description={`Say "new line", "new paragraph", or "open quote" and "close quote".`}
        keywords={["new line", "new paragraph", "line break", "quote", "formatting"]}
        checked={cleanup.formatting}
        onReset={resetTo(cleanup.formatting, initial.formatting, {
          spokenFormatting: initial.formatting,
        })}
        onChange={(next) => onChange({ spokenFormatting: next })}
      />
      <Toggle
        label="Spoken symbols"
        description={`"foo underscore bar" types foo_bar. Say "literal" first to keep a symbol's word.`}
        keywords={["symbols", "underscore", "dot", "slash", "backtick", "paren", "code"]}
        checked={cleanup.symbols}
        onReset={resetTo(cleanup.symbols, initial.symbols, { spokenSymbols: initial.symbols })}
        onChange={(next) => onChange({ spokenSymbols: next })}
        learnMore={
          <p>
            underscore, dash, hyphen, dot, slash, backslash, colon, double colon, semicolon, comma,
            backtick, triple backtick, asterisk, tilde, ampersand, at sign, hash sign, hashtag,
            dollar sign, equals sign, double and triple equals, plus sign, fat arrow, dash dash,
            question mark, exclamation mark, and open and close paren, bracket, brace and angle
            bracket. After "a" or "the" a word stays as it is, as in "a dot on the screen".
          </p>
        }
      />
    </>
  );
}
