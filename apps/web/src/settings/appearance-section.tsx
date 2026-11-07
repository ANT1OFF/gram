import { APP_ICONS, type AppIconId } from "@gram/contracts";
import { derivePalette, PRESET_PALETTES, type Palette, type SemanticColors } from "@gram/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, CircleDashed, CircleDot, Play, SquareTerminal } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from "react";

import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Expand } from "@/motion/expand";
import { GlideItem, GlideList } from "@/motion/glide";
import { NumberTicker } from "@/motion/number-ticker";
import { PressScale } from "@/motion/press-scale";
import { ChoiceCheck } from "@/components/choice-check";
import { SegmentSlab } from "@/motion/segment-slab";
import { Shimmer } from "@/motion/shimmer";
import { Spinner } from "@/motion/spinner";
import { useThemeStore } from "@/theme/store";
import { useSystemPrefs } from "@/theme/system";
import {
  CONTRAST_PREFS,
  DENSITY_PREFS,
  MODE_PREFS,
  MOTION_PREFS,
  themeAttributes,
  type ThemePrefs,
} from "@/theme/theme";
import { switchTheme, type Point } from "@/theme/transition";

import {
  LONG_COPY,
  OPTION_GROUP,
  SEGMENT,
  SEGMENT_ROOMY,
  SEGMENT_SLAB,
  SettingRow,
} from "./fields";
import { FontsSection } from "./fonts-section";
import { PaletteEditor } from "./palette-editor";
import { paletteChoices, type PaletteChoice } from "./palette-choices";
import { ReadingSection } from "./reading-section";
import { SearchScope, useSettingSearch } from "./search-scope";
import { SettingDescription } from "./help-tip";
import { GROUP_TITLE, SETTINGS_STACK, SettingsGroup } from "./settings-group";

/** The click point, or the control's centre when activated from the keyboard. */
function originOf(event: MouseEvent<HTMLElement>): Point {
  if (event.detail > 0) return { x: event.clientX, y: event.clientY };
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function useThemePrefs(): ThemePrefs {
  const look = useThemeStore((s) => s.look);
  const palette = useThemeStore((s) => s.palette);
  const mode = useThemeStore((s) => s.mode);
  const density = useThemeStore((s) => s.density);
  const contrast = useThemeStore((s) => s.contrast);
  const motion = useThemeStore((s) => s.motion);
  return { look, palette, mode, density, contrast, motion };
}

function useThemeAttributes() {
  const prefs = useThemePrefs();
  const customPalettes = useThemeStore((s) => s.customPalettes);
  const system = useSystemPrefs();
  const palettes: readonly Palette[] = [...PRESET_PALETTES, ...customPalettes];
  return { prefs, palettes, attrs: themeAttributes(prefs, system, palettes) };
}

/**
 * Settings → Appearance: the theme's choices as rows (Mode, Density, Contrast, Motion), then
 * Reading, then the palette grid beside a live preview, then fonts. The rows and Reading come
 * first, so the settings changed most sit above the fold rather than under the palette grid. Glass
 * is the only look; the palette editor opens from the palette grid.
 */
export function AppearanceSettings() {
  return <AppearancePage preview />;
}

/** What Settings search holds of Appearance from another page: everything but the live preview. */
export function AppearanceSearch() {
  return <AppearancePage preview={false} />;
}

function AppearancePage({ preview }: { preview: boolean }) {
  const [editing, setEditing] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const editColours = () => {
    setEditing(true);
    requestAnimationFrame(() => editor.current?.scrollIntoView({ block: "nearest" }));
  };
  const palette = <PaletteControls onEditColours={editColours} />;
  return (
    <div className={cn("@container", SETTINGS_STACK)}>
      <ThemeRows />
      <SettingsGroup
        label="Reading"
        description="The size and width of the conversation in threads."
        keywords={READING_KEYWORDS}
        testId="reading-settings"
      >
        <ReadingSection />
      </SettingsGroup>
      {preview ? (
        <div className="grid gap-6 @3xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          {palette}
          <SearchScope
            label="Preview"
            className="grid content-start gap-4 @xl:grid-cols-[14rem_minmax(0,1fr)]"
          >
            <SidebarSample />
            <ToolCardSample />
          </SearchScope>
        </div>
      ) : (
        palette
      )}
      {editing && (
        <div ref={editor} className="flex flex-col gap-2">
          <SearchScope label="Edit colours" keywords={PALETTE_EDITOR_KEYWORDS}>
            <PaletteEditor />
          </SearchScope>
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => setEditing(false)}
          >
            Done editing colours
          </Button>
        </div>
      )}
      <SettingsGroup
        label="Fonts"
        description="The typefaces and sizes for text and code."
        keywords={FONT_KEYWORDS}
        testId="font-settings"
      >
        <FontsSection />
      </SettingsGroup>
    </div>
  );
}

const PALETTE_HINT = "Each has a light and a dark version; Mode picks which one shows.";
const FONT_KEYWORDS = ["typeface", "family", "monospace"];
const READING_KEYWORDS = ["transcript", "conversation", "text size", "line width"];
const PALETTE_EDITOR_KEYWORDS = ["custom palette", "edit palette", "colour", "color", "seed"];

/** Mode, Density, Contrast and Motion: one row each, as every other Settings page's rows. */
function ThemeRows() {
  const prefs = useThemePrefs();
  return (
    <SettingsGroup
      label="Theme"
      description="Light or dark, and how much room and motion the app uses."
      keywords={["appearance"]}
      testId="theme-settings"
    >
      <Segmented
        label="Mode"
        description="Follow the system, or stay light or dark."
        keywords={["dark", "light", "theme"]}
        value={prefs.mode}
        options={MODE_PREFS}
        onSelect={(mode, event) => switchTheme({ mode }, originOf(event))}
      />
      <Segmented
        label="Density"
        description="How much room rows and controls take."
        keywords={["compact", "comfortable", "spacing"]}
        value={prefs.density}
        options={DENSITY_PREFS}
        onSelect={(density) => switchTheme({ density })}
      />
      <Segmented
        label="Contrast"
        description="System uses more contrast when the OS asks for it."
        keywords={["accessibility"]}
        value={prefs.contrast}
        options={CONTRAST_PREFS}
        onSelect={(contrast, event) => switchTheme({ contrast }, originOf(event))}
      />
      <Segmented
        label="Motion"
        description="System is full motion unless the OS asks for less."
        keywords={["animation", "reduced", "transitions"]}
        value={prefs.motion}
        options={MOTION_PREFS}
        onSelect={(motion) => switchTheme({ motion })}
      />
    </SettingsGroup>
  );
}

/** The palette grid with its editor's door, and the desktop app's icon under it. */
function PaletteControls({ onEditColours }: { onEditColours: () => void }) {
  const { prefs, attrs, palettes } = useThemeAttributes();
  const customPalettes = useThemeStore((s) => s.customPalettes);
  const choices = paletteChoices(prefs.palette, customPalettes);
  const shownMode = attrs["data-mode"];
  return (
    <SearchScope label="Palette" className="flex flex-col gap-5">
      <Control
        label="Palette"
        keywords={["theme", "colour", "color", "custom palette", "edit palette"]}
        hint={PALETTE_HINT}
        hintFirst
      >
        <div className="grid grid-cols-2 gap-2 @md:grid-cols-3">
          {choices.map((choice) => (
            <PaletteCard
              key={choice.id}
              choice={choice}
              palette={palettes.find((p) => p.id === shownHalf(choice, shownMode))}
              selected={
                choice.ids.includes(prefs.palette) || choice.ids.includes(attrs["data-palette"])
              }
              onSelect={(event) =>
                switchTheme({ palette: shownHalf(choice, attrs["data-mode"]) }, originOf(event))
              }
            />
          ))}
        </div>
        <Button size="xs" variant="ghost" className="self-start" onClick={onEditColours}>
          Edit colours…
        </Button>
      </Control>

      <AppIconControl />
    </SearchScope>
  );
}

const APP_ICON_NAMES: Record<AppIconId, string> = {
  gift: "Gift rune",
  fanout: "Fan-out",
  blade: "Sword",
  glass: "Runes on glass",
};

const appIconHint = (platform: string | undefined) =>
  platform === "linux"
    ? "Shows in the taskbar while Gram runs. The app launcher keeps the Gift rune."
    : "Shows in the Dock or taskbar while Gram runs. Finder and the Start menu keep the Gift rune.";

/** The desktop app's Dock or taskbar icon; absent in a browser or a shell older than it. */
export function AppIconControl() {
  const bridge = window.gram?.appIcon;
  const queries = useQueryClient();
  const { data: current } = useQuery({
    queryKey: ["app-icon"],
    queryFn: () => bridge!.get(),
    enabled: bridge !== undefined,
  });
  const choose = useMutation({
    mutationFn: (icon: AppIconId) => bridge!.set(icon),
    onSuccess: (_result, icon) => queries.setQueryData(["app-icon"], icon),
  });
  if (bridge === undefined) return null;
  return (
    <Control
      label="App icon"
      keywords={["dock", "taskbar", "logo", "icon"]}
      hint={appIconHint(window.gram?.platform)}
    >
      <div role="group" aria-label="App icon" className="grid grid-cols-4 gap-1.5">
        {APP_ICONS.map((icon) => (
          <button
            key={icon}
            type="button"
            aria-pressed={icon === current}
            aria-label={APP_ICON_NAMES[icon]}
            title={APP_ICON_NAMES[icon]}
            disabled={choose.isPending}
            onClick={() => choose.mutate(icon)}
            className={cn(
              "relative flex flex-col items-center gap-1 rounded-md border border-border p-1.5 outline-none hover:bg-accent focus-visible:focus-ring",
              icon === current && "choice-selected hover:choice-selected",
            )}
          >
            <ChoiceCheck checked={icon === current} className="absolute top-1 right-1" />
            <img src={`/app-icons/${icon}.png`} alt="" className="size-10" draggable={false} />
            <span className="text-caption leading-tight text-muted-foreground">
              {APP_ICON_NAMES[icon]}
            </span>
          </button>
        ))}
      </div>
      {choose.isError && (
        <p role="alert" className="text-meta text-destructive">
          Couldn't change the icon: {errorMessage(choose.error)}
        </p>
      )}
    </Control>
  );
}

/** The half of a pair the screen shows now, so the colour editor starts from what is on screen. */
const shownHalf = (choice: PaletteChoice, mode: string) =>
  (mode === "light" ? choice.ids[0] : choice.ids.at(-1)) ?? choice.id;

function PaletteCard({
  choice,
  palette,
  selected,
  onSelect,
}: {
  choice: PaletteChoice;
  /** The half the screen's mode shows, which the sample is drawn in. */
  palette: Palette | undefined;
  selected: boolean;
  onSelect: (event: MouseEvent<HTMLElement>) => void;
}) {
  const colors = useMemo(
    () => (palette === undefined ? undefined : derivePalette(palette).colors),
    [palette],
  );
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      data-palette-choice={choice.id}
      className={cn(
        "flex flex-col gap-1.5 rounded-md border border-border p-1.5 text-left outline-none hover:bg-accent focus-visible:focus-ring",
        selected && "choice-selected hover:choice-selected",
      )}
    >
      {colors === undefined ? (
        <span aria-hidden className="flex h-3.5 overflow-hidden rounded-xs">
          {choice.swatch.map((hex, i) => (
            <span key={i} className="flex-1" style={{ backgroundColor: hex }} />
          ))}
        </span>
      ) : (
        <PaletteSample colors={colors} />
      )}
      <span className="flex items-center gap-1 px-0.5 text-body font-medium">
        {choice.name}
        <ChoiceCheck checked={selected} className="ml-auto" />
      </span>
      {choice.note && <span className="px-0.5 text-meta text-muted-foreground">{choice.note}</span>}
    </button>
  );
}

/** A thin line standing for text, in a palette's own colour. */
function SampleLine({ color, width }: { color: string; width: string }) {
  return <span className="block h-1 rounded-full" style={{ backgroundColor: color, width }} />;
}

/** A status dot, in a palette's own colour. */
function SampleDot({ color }: { color: string }) {
  return <span className="size-1 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

/**
 * A palette in miniature, in its own colours rather than the page's: a sidebar with its current
 * row and status dots, a conversation with a message and a reply, and a diff's added and removed
 * lines.
 */
function PaletteSample({ colors }: { colors: SemanticColors }) {
  return (
    <span
      aria-hidden
      data-testid="palette-sample"
      className="flex h-14 overflow-hidden rounded-xs border border-border"
      style={{ backgroundColor: colors["surface-2"] }}
    >
      <span
        className="flex w-[30%] flex-col gap-1 p-1"
        style={{ backgroundColor: colors["surface-1"] }}
      >
        <span
          className="flex items-center gap-0.5 rounded-2xs p-0.5"
          style={{ backgroundColor: colors.selection }}
        >
          <SampleDot color={colors["status-working"]} />
          <SampleLine color={colors.fg} width="70%" />
        </span>
        <span className="flex items-center gap-0.5 px-0.5">
          <SampleDot color={colors["status-needs-mark"]} />
          <SampleLine color={colors["fg-muted"]} width="60%" />
        </span>
        <span className="flex items-center gap-0.5 px-0.5">
          <SampleDot color={colors["fg-subtle"]} />
          <SampleLine color={colors["fg-muted"]} width="50%" />
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 p-1">
        <span
          className="ms-auto block h-2 w-3/5 rounded-2xs"
          style={{ backgroundColor: colors["surface-3"] }}
        />
        <SampleLine color={colors.fg} width="85%" />
        <SampleLine color={colors["fg-muted"]} width="65%" />
        <span className="mt-auto flex flex-col overflow-hidden rounded-2xs">
          <span
            className="flex h-2 items-center px-0.5"
            style={{ backgroundColor: colors["diff-add-bg"] }}
          >
            <SampleLine color={colors["diff-add-fg"]} width="70%" />
          </span>
          <span
            className="flex h-2 items-center px-0.5"
            style={{ backgroundColor: colors["diff-del-bg"] }}
          >
            <SampleLine color={colors["diff-del-fg"]} width="55%" />
          </span>
        </span>
      </span>
    </span>
  );
}

/** One Appearance control under its caption, found in Settings search by the caption and hint. */
function Control({
  label,
  hint,
  hintFirst = false,
  keywords,
  children,
}: {
  label: string;
  hint?: string;
  /** The hint above the control, for one with an action of its own below. */
  hintFirst?: boolean;
  keywords?: readonly string[];
  children: ReactNode;
}) {
  const search = useSettingSearch({ label, description: hint, keywords });
  return (
    <section {...search} className="flex flex-col gap-2">
      <h3 className={GROUP_TITLE}>{label}</h3>
      {hintFirst && hint && <SettingDescription>{hint}</SettingDescription>}
      {children}
      {!hintFirst && hint && <SettingDescription>{hint}</SettingDescription>}
    </section>
  );
}

function Segmented<T extends string>({
  label,
  description,
  value,
  options,
  keywords,
  onSelect,
}: {
  label: string;
  description: string;
  value: T;
  options: readonly T[];
  keywords?: readonly string[];
  onSelect: (value: T, event: MouseEvent<HTMLElement>) => void;
}) {
  const slab = useId();
  return (
    <SettingRow label={label} description={description} {...(keywords ? { keywords } : {})}>
      <div role="group" aria-label={label} className={OPTION_GROUP}>
        {options.map((option) => (
          <Button
            key={option}
            size="sm"
            variant="ghost"
            aria-pressed={option === value}
            className={cn(SEGMENT, SEGMENT_ROOMY, "capitalize")}
            onClick={(event) => onSelect(option, event)}
          >
            {option === value && <SegmentSlab group={slab} className={SEGMENT_SLAB} />}
            {option}
          </Button>
        ))}
      </div>
    </SettingRow>
  );
}

function PreviewCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      {...{ [LONG_COPY]: "sample thread" }}
      className={cn(
        "rounded-lg border-(length:--card-border-width) border-edge bg-card p-3 shadow-raised backdrop-blur-(--surface-blur)",
        className,
      )}
    >
      {children}
    </div>
  );
}

type SampleStatus = "needs-you" | "working" | "idle";

const GROUPS: {
  status: SampleStatus;
  label: string;
  icon: ComponentType<{ className?: string }>;
  tone: string;
}[] = [
  {
    status: "needs-you",
    label: "Needs you",
    icon: CircleDot,
    tone: "text-status-needs",
  },
  {
    status: "working",
    label: "Working",
    icon: Spinner,
    tone: "text-status-working",
  },
  {
    status: "idle",
    label: "Idle",
    icon: CircleDashed,
    tone: "text-status-idle",
  },
];

const NEXT_STATUS: Record<SampleStatus, SampleStatus> = {
  working: "needs-you",
  "needs-you": "idle",
  idle: "working",
};

const SAMPLE_ROWS: {
  id: string;
  project: string;
  name: string;
  status: SampleStatus;
}[] = [
  {
    id: "fix-flaky",
    project: "api",
    name: "fix-flaky-test",
    status: "needs-you",
  },
  { id: "ui-pass", project: "web", name: "ui-pass", status: "working" },
  { id: "rewrite", project: "docs", name: "rewrite", status: "working" },
  { id: "bump-deps", project: "api", name: "bump-deps", status: "idle" },
  { id: "changelog", project: "web", name: "changelog", status: "idle" },
];

interface SidebarSampleState {
  rows: typeof SAMPLE_ROWS;
  next: number;
}

const advanceSample = (s: SidebarSampleState): SidebarSampleState => ({
  rows: s.rows.map((row, i) => (i === s.next ? { ...row, status: NEXT_STATUS[row.status] } : row)),
  next: (s.next + 2) % s.rows.length,
});

function SidebarSample() {
  const [sample, setSample] = useState<SidebarSampleState>({
    rows: SAMPLE_ROWS,
    next: 1,
  });
  const [auto, setAuto] = useState(true);
  const step = () => setSample(advanceSample);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => setSample(advanceSample), 2400);
    return () => clearInterval(id);
  }, [auto]);

  return (
    <aside className="flex flex-col rounded-lg border-(length:--card-border-width) border-border bg-sidebar p-2 text-sidebar-foreground shadow-raised backdrop-blur-(--surface-blur)">
      <GlideList id="appearance-sidebar">
        {GROUPS.map((group) => {
          const rows = sample.rows.filter((row) => row.status === group.status);
          return (
            <section key={group.status} className="mb-2">
              <h3 className="flex items-center gap-1.5 px-2 py-1 text-meta font-medium text-muted-foreground">
                <group.icon className={cn("size-icon-chip", group.tone)} />
                {group.label}
                <NumberTicker className="ml-auto tabular-nums" value={rows.length} />
              </h3>
              <ul>
                {rows.map((row) => (
                  <GlideItem
                    key={row.id}
                    glideId={row.id}
                    className="flex h-(--sidebar-row-height) items-center gap-1.5 rounded-(--sidebar-row-radius) px-2 text-reading hover:bg-sidebar-row-hover"
                  >
                    <span className="text-muted-foreground">{row.project}</span>
                    <span className="text-subtle">•</span>
                    <span className="truncate">{row.name}</span>
                  </GlideItem>
                ))}
              </ul>
            </section>
          );
        })}
      </GlideList>
      <div className="mt-auto flex gap-1 border-t border-border pt-2">
        <Button size="xs" variant="ghost" onClick={step}>
          Move a row
        </Button>
        <Button size="xs" variant="ghost" aria-pressed={auto} onClick={() => setAuto((a) => !a)}>
          {auto ? "Pause" : "Auto"}
        </Button>
      </div>
    </aside>
  );
}

const TOOL_OUTPUT = ` ✓ src/retry.test.ts (4 tests) 812ms
   ✓ retries with backoff
   ✓ gives up after 3 attempts

 Test Files  1 passed (1)
      Tests  4 passed (4)`;

function ToolCardSample() {
  const [open, setOpen] = useState(true);
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(1.2);

  useEffect(() => {
    if (!running) return;
    const id = setTimeout(() => {
      setRunning(false);
      setSeconds(0.8 + Math.random());
    }, 1800);
    return () => clearTimeout(id);
  }, [running]);

  return (
    <PreviewCard className="self-start">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="appearance-tool-output"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-reading outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronRight
            className={cn(
              "size-icon-chip shrink-0 text-muted-foreground transition-transform duration-(--dur-move-fast)",
              open && "rotate-90",
            )}
          />
          <SquareTerminal className="size-icon-row shrink-0 text-muted-foreground" />
          <span className="font-medium">Bash</span>
          <code className="truncate font-mono text-meta text-muted-foreground">
            pnpm test retry
          </code>
        </button>
        {running ? (
          <Shimmer className="text-meta text-muted-foreground">Running…</Shimmer>
        ) : (
          <span className="flex items-center gap-1 text-meta text-success-text">
            <Check className="size-icon-row" />
            {seconds.toFixed(1)}s
          </span>
        )}
        <PressScale>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Run again"
            disabled={running}
            onClick={() => {
              setRunning(true);
              setOpen(true);
            }}
          >
            <Play />
          </Button>
        </PressScale>
      </div>
      <Expand open={open} id="appearance-tool-output">
        <pre className="mt-2 overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-meta leading-relaxed text-muted-foreground">
          {TOOL_OUTPUT}
        </pre>
      </Expand>
    </PreviewCard>
  );
}
