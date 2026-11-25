import {
  ACCENTS,
  accentColor,
  SCENES,
  sceneSvg,
  SURFACES_IDS,
  type AccentId,
  type Mode,
  type SceneId,
  type SurfacesId,
} from "@gram/themes";
import { useId, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SegmentSlab } from "@/motion/segment-slab";
import {
  SIDEBAR_ICON_PREFS,
  SIDEBAR_PREFS,
  type BackdropPref,
  type SidebarIconsPref,
  type SidebarPref,
  type ThemePrefs,
} from "@/theme/theme";
import { switchTheme } from "@/theme/transition";

import { OPTION_GROUP, SEGMENT, SEGMENT_ROOMY, SEGMENT_SLAB, SettingRow } from "./fields";
import { SettingsGroup } from "./settings-group";

const SURFACE_LABELS: Record<SurfacesId, string> = {
  solid: "Solid",
  frosted: "Frosted",
  clear: "See-through",
};
const SIDEBAR_LABELS: Record<SidebarPref, string> = { flush: "Straight", inset: "Rounded" };
const ICON_LABELS: Record<SidebarIconsPref, string> = { plain: "Plain", accent: "Accent" };

const CHOSEN = "ring-2 ring-foreground ring-offset-2 ring-offset-card";

export function LookRows({ prefs, mode }: { prefs: ThemePrefs; mode: Mode }) {
  const backdrop = prefs.backdrop ?? "off";
  return (
    <SettingsGroup
      label="Accent and background"
      description="An accent over the palette, a picture behind the app, and the sidebar's shape."
      keywords={["appearance", "wallpaper"]}
      testId="look-settings"
    >
      <SettingRow
        label="Accent"
        description="Buttons, links, focus and the current place. Each has a light and a dark value."
        keywords={["colour", "color", "highlight"]}
      >
        <Accents value={prefs.accent} mode={mode} />
      </SettingRow>
      <SettingRow
        label="Background picture"
        description="A calm scene behind the app: a dawn version in light, a night one in dark."
        keywords={["wallpaper", "image", "backdrop"]}
      >
        <Pictures value={backdrop} mode={mode} />
      </SettingRow>
      {backdrop !== "off" && (
        <Choice
          label="Surfaces"
          description="How much of the picture shows through cards, the sidebar and the title bar."
          keywords={["transparency", "frosted", "glass", "see-through"]}
          value={prefs.surfaces ?? "solid"}
          options={SURFACES_IDS}
          labels={SURFACE_LABELS}
          onSelect={(surfaces) => switchTheme({ surfaces })}
        />
      )}
      <Choice
        label="Sidebar"
        description="Flush with the window's edges, or a panel with round corners set in from them."
        keywords={["corners", "inset", "round"]}
        value={prefs.sidebar ?? "flush"}
        options={SIDEBAR_PREFS}
        labels={SIDEBAR_LABELS}
        onSelect={(sidebar) => switchTheme({ sidebar })}
      />
      <Choice
        label="Sidebar icons"
        description="In their row's colour, or all in the accent."
        keywords={["icon colour", "icon color"]}
        value={prefs.sidebarIcons ?? "plain"}
        options={SIDEBAR_ICON_PREFS}
        labels={ICON_LABELS}
        onSelect={(sidebarIcons) => switchTheme({ sidebarIcons })}
      />
    </SettingsGroup>
  );
}

function Accents({ value, mode }: { value: AccentId | "palette" | undefined; mode: Mode }) {
  return (
    <Radios label="Accent">
      <Radio
        label="The palette's own"
        checked={value === undefined || value === "palette"}
        onSelect={() => switchTheme({ accent: "palette" })}
        className="size-6 rounded-full border border-dashed border-border-strong"
      />
      {ACCENTS.map((accent) => (
        <Radio
          key={accent.id}
          label={accent.name}
          checked={value === accent.id}
          onSelect={() => switchTheme({ accent: accent.id })}
          className="size-6 rounded-full shadow-[inset_0_0_0_1px_var(--border-subtle)]"
          style={{ background: accentColor(accent.id, mode) }}
        />
      ))}
    </Radios>
  );
}

function Pictures({ value, mode }: { value: BackdropPref; mode: Mode }) {
  const tile =
    "h-10 w-16 overflow-hidden rounded-md border border-border-subtle [&_svg]:block [&_svg]:size-full";
  return (
    <Radios label="Background picture">
      <Radio
        label="Off"
        checked={value === "off"}
        onSelect={() => switchTheme({ backdrop: "off" })}
        className={cn(tile, "grid place-items-center text-meta text-muted-foreground")}
      >
        Off
      </Radio>
      {SCENES.map((scene) => (
        <Picture
          key={scene.id}
          scene={scene}
          mode={mode}
          checked={value === scene.id}
          tile={tile}
        />
      ))}
    </Radios>
  );
}

function Picture({
  scene,
  mode,
  checked,
  tile,
}: {
  scene: { readonly id: SceneId; readonly name: string };
  mode: Mode;
  checked: boolean;
  tile: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={scene.name}
      title={scene.name}
      onClick={() => switchTheme({ backdrop: scene.id })}
      className={cn(tile, "outline-none focus-visible:focus-ring", checked && CHOSEN)}
      dangerouslySetInnerHTML={{ __html: sceneSvg(scene.id, mode === "dark", `pick-${scene.id}`) }}
    />
  );
}

function Radios({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap justify-end gap-2">
      {children}
    </div>
  );
}

function Radio({
  label,
  checked,
  onSelect,
  className,
  style,
  children,
}: {
  label: string;
  checked: boolean;
  onSelect: () => void;
  className: string;
  style?: { background: string };
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={onSelect}
      className={cn(className, "outline-none focus-visible:focus-ring", checked && CHOSEN)}
      {...(style ? { style } : {})}
    >
      {children}
    </button>
  );
}

function Choice<T extends string>({
  label,
  description,
  keywords,
  value,
  options,
  labels,
  onSelect,
}: {
  label: string;
  description: string;
  keywords: readonly string[];
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onSelect: (value: T) => void;
}) {
  const slab = useId();
  return (
    <SettingRow label={label} description={description} keywords={keywords}>
      <div role="group" aria-label={label} className={OPTION_GROUP}>
        {options.map((option) => (
          <Button
            key={option}
            size="sm"
            variant="ghost"
            aria-pressed={option === value}
            className={cn(SEGMENT, SEGMENT_ROOMY)}
            onClick={() => onSelect(option)}
          >
            {option === value && <SegmentSlab group={slab} className={SEGMENT_SLAB} />}
            {labels[option]}
          </Button>
        ))}
      </div>
    </SettingRow>
  );
}
