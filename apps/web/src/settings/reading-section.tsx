import {
  TRANSCRIPT_TEXT_SIZE,
  transcriptTextSizeOf,
  transcriptWidthOf,
  type SettingsPatch,
  type TranscriptWidth,
} from "@gram/contracts";
import { Minus, Plus } from "lucide-react";
import { useState, type CSSProperties } from "react";

import { errorMessage } from "@/api/errors";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { useServerSettings } from "@/settings-sync/store";
import { readingVars } from "@/thread/reading";

import { READING_DEFAULTS, resetFor } from "./defaults";
import { LONG_COPY, OptionGroup, SEGMENT_TRACK, SettingRow } from "./fields";
import { useSaveSettings } from "./use-save-settings";

type ReadingKey = keyof typeof READING_DEFAULTS;

const WIDTHS: readonly { value: TranscriptWidth; label: string }[] = [
  { value: "narrow", label: "Narrow" },
  { value: "comfortable", label: "Comfortable" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];

/**
 * How much of the preview's frame the sample column takes for each width: the columns' own widths
 * (40, 48 and 64rem, and all of it) against a 72rem pane, about a 1440px window beside the sidebar.
 */
const PREVIEW_COLUMN: Readonly<Record<TranscriptWidth, string>> = {
  narrow: "56%",
  comfortable: "67%",
  wide: "89%",
  full: "100%",
};

/** What a change has saved yet, so the preview follows a click before the save comes back. */
interface Pending {
  readonly textSize?: number;
  readonly width?: TranscriptWidth;
}

/**
 * Settings → Appearance → Reading, as rows of its group's card: the transcript's text size and
 * width, and a sample message that shows both as they change. Applied through `thread/reading.ts`.
 */
export function ReadingSection() {
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const [pending, setPending] = useState<Pending>({});
  const [failed, setFailed] = useState<{ key: ReadingKey; message: string }>();

  if (!settings) return null;
  const size = pending.textSize ?? transcriptTextSizeOf(settings);
  const width = pending.width ?? transcriptWidthOf(settings);

  const send = <K extends ReadingKey>(
    key: K,
    value: NonNullable<Pending[K]>,
    patch: SettingsPatch,
  ) => {
    setFailed(undefined);
    setPending((p) => ({ ...p, [key]: value }));
    save(patch)
      .catch((e: unknown) => setFailed({ key, message: errorMessage(e) }))
      .finally(() => setPending((p) => (p[key] === value ? { ...p, [key]: undefined } : p)));
  };
  // The default is stored as unset, so a later change to the default reaches it.
  const setSize = (next: number) =>
    send("textSize", next, {
      reading: { textSize: next === TRANSCRIPT_TEXT_SIZE.default ? null : next },
    });
  const setWidth = (next: TranscriptWidth) =>
    send("width", next, { reading: { width: next === "comfortable" ? null : next } });
  const errorOf = (key: ReadingKey) => (failed?.key === key ? failed.message : undefined);
  const resetOf = (key: ReadingKey) =>
    resetFor(settings, (patch) => {
      setFailed(undefined);
      save(patch).catch((e: unknown) => setFailed({ key, message: errorMessage(e) }));
    })(READING_DEFAULTS[key]);

  return (
    <>
      <SettingRow
        label="Transcript text size"
        description={`Message text in threads, ${TRANSCRIPT_TEXT_SIZE.min}–${TRANSCRIPT_TEXT_SIZE.max} px. Code and headings scale with it.`}
        keywords={["font size", "larger text", "zoom", "readability", "accessibility"]}
        onReset={resetOf("textSize")}
        error={errorOf("textSize")}
      >
        <SizeStepper value={size} onChange={setSize} />
      </SettingRow>
      <SettingRow
        label="Transcript width"
        description="How wide the conversation column grows before lines wrap. Comfortable is the original."
        keywords={["line length", "column", "max width", "readability"]}
        onReset={resetOf("width")}
        error={errorOf("width")}
      >
        <OptionGroup label="Transcript width" options={WIDTHS} value={width} onChange={setWidth} />
      </SettingRow>
      <SettingRow
        label="Preview"
        description="A sample message at this size and width."
        keywords={["reading", "sample"]}
        detail={<ReadingPreview size={size} width={width} />}
      />
    </>
  );
}

function SizeStepper({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  return (
    <div role="group" aria-label="Transcript text size" className={SEGMENT_TRACK}>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Smaller transcript text"
        disabled={value <= TRANSCRIPT_TEXT_SIZE.min}
        onClick={() => onChange(value - 1)}
      >
        <Minus />
      </Button>
      <output
        aria-live="polite"
        data-testid="transcript-text-size"
        className="flex min-w-14 items-center justify-center text-sm tabular-nums"
      >
        {value} px
      </output>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Larger transcript text"
        disabled={value >= TRANSCRIPT_TEXT_SIZE.max}
        onClick={() => onChange(value + 1)}
      >
        <Plus />
      </Button>
    </div>
  );
}

/**
 * A user message and a reply in a frame standing for the thread pane, styled by the same rules as a
 * real transcript (`data-transcript`), with this size's variables set on it. The column takes the
 * width's share of the frame; the text is at its real size.
 */
function ReadingPreview({ size, width }: { size: number; width: TranscriptWidth }) {
  const vars = readingVars({ textSize: size, width }) as CSSProperties;
  return (
    <div
      data-testid="reading-preview"
      {...{ [LONG_COPY]: "sample thread" }}
      className="overflow-hidden rounded-md border border-border/60 bg-thread px-3 py-4"
    >
      <div
        data-transcript=""
        style={{ ...vars, width: PREVIEW_COLUMN[width] }}
        className="mx-auto flex flex-col gap-4 motion-safe:transition-[width] motion-safe:duration-(--dur-move-fast)"
      >
        <Message from="user">
          <MessageContent className="whitespace-pre-wrap">
            Why does the retry test fail on CI but pass locally?
          </MessageContent>
        </Message>
        <Message from="assistant">
          <MessageContent className="w-full">
            <div className="flex flex-col gap-3">
              <p>
                The test waits on a real timer. CI machines are slower, so the third attempt lands
                after{" "}
                <code
                  data-streamdown="inline-code"
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm"
                >
                  timeout
                </code>{" "}
                expires. Faking the clock makes it deterministic:
              </p>
              <div
                data-streamdown="code-block-body"
                className="overflow-x-auto rounded-md border border-border bg-background p-4 font-mono text-sm"
              >
                <pre>
                  <code>vi.useFakeTimers();{"\n"}await vi.advanceTimersByTimeAsync(3_000);</code>
                </pre>
              </div>
            </div>
          </MessageContent>
        </Message>
      </div>
    </div>
  );
}
