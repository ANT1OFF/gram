import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { normaliseKeys, type BindingRow } from "@/keyboard/bindings";
import type { BindingOverrides } from "@/keyboard/bindings-store";
import { formatKeys, isAltGraphText, isMac, keysFromEvent } from "@/keyboard/registry";
import { Dialog, DialogShell } from "@/thread/dialog-shell";

/** Shortcuts macOS keeps for itself, so the app may never see them. */
const MAC_SYSTEM_KEYS: Readonly<Record<string, string>> = {
  "mod+shift+3": "takes a screenshot",
  "mod+shift+4": "takes a screenshot of a selection",
  "mod+shift+5": "opens the screenshot toolbar",
  "mod+q": "quits the app",
  "mod+h": "hides the app",
};

const MODIFIERS = new Set(["Meta", "Control", "Alt", "AltGraph", "Shift", "CapsLock", "Fn"]);

/** Why a press recorded nothing; a lone modifier is still being held, so it says nothing. */
function unusableReason(event: KeyboardEvent, mac: boolean): string | undefined {
  if (MODIFIERS.has(event.key)) return undefined;
  if (isAltGraphText(event, mac)) return "AltGr keys type characters and can't be shortcuts.";
  if (!mac && event.metaKey) return "The Windows key can't be part of a shortcut.";
  return "That key can't be part of a shortcut.";
}

type Capture =
  | { readonly state: "recording" }
  | { readonly state: "recorded"; readonly keys: string }
  | { readonly state: "off" };

/**
 * Records new keys for one shortcut. While recording, every press is taken and app shortcuts don't
 * fire; Escape cancels and Backspace or Delete turns the shortcut off. A clash names the other
 * action and offers to take its keys; macOS system keys get a warning.
 */
export function KeyCaptureDialog({
  row,
  rows,
  mac = isMac(),
  onSave,
  onClose,
}: {
  row: BindingRow;
  rows: readonly BindingRow[];
  mac?: boolean;
  onSave: (changes: BindingOverrides) => void;
  onClose: () => void;
}) {
  const [capture, setCapture] = useState<Capture>({ state: "recording" });
  const [unusable, setUnusable] = useState<string | undefined>();
  const recording = capture.state === "recording";

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape still reaches the dialog, which closes.
      if (event.key === "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (plain && (event.key === "Backspace" || event.key === "Delete")) {
        setUnusable(undefined);
        setCapture({ state: "off" });
        return;
      }
      const keys = keysFromEvent(event, mac);
      if (keys === undefined) {
        setUnusable(unusableReason(event, mac));
        return;
      }
      setUnusable(undefined);
      setCapture({ state: "recorded", keys });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, mac]);

  const keys = capture.state === "recorded" ? capture.keys : undefined;
  const clashes =
    keys === undefined
      ? []
      : rows.filter(
          (other) =>
            other.id !== row.id &&
            other.keys !== undefined &&
            normaliseKeys(other.keys) === normaliseKeys(keys),
        );
  const systemUse = keys !== undefined && mac ? MAC_SYSTEM_KEYS[normaliseKeys(keys)] : undefined;
  const shown = keys === undefined ? undefined : formatKeys(keys, mac);

  const save = (replace: boolean) => {
    const value = capture.state === "off" ? null : keys;
    if (value === undefined) return;
    const others = replace ? Object.fromEntries(clashes.map((other) => [other.id, null])) : {};
    onSave({ ...others, [row.id]: value });
  };

  return (
    <DialogShell
      testId="key-capture-dialog"
      title={`Change “${row.label}”`}
      description={`Now ${row.keys === undefined ? "off" : formatKeys(row.keys, mac)}; the default is ${formatKeys(row.defaultKeys, mac)}.`}
      onClose={onClose}
    >
      <p data-testid="key-capture-status" role="status" aria-live="polite" className="text-sm">
        {recording
          ? "Recording: press the new keys. Escape cancels; Backspace turns the shortcut off."
          : capture.state === "off"
            ? `${row.label} will be off.`
            : `Recorded ${shown}.`}
      </p>
      <kbd
        aria-hidden
        className="self-start rounded border border-border bg-muted px-2 py-1 font-mono text-lg"
      >
        {recording ? "…" : (shown ?? "Off")}
      </kbd>
      {unusable && (
        <p data-testid="key-capture-unusable" className="text-xs text-destructive">
          {unusable}
        </p>
      )}
      {clashes.length > 0 && (
        <p
          data-testid="key-capture-clash"
          className="flex items-start gap-1.5 text-xs text-status-needs"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Same keys as {clashes.map((other) => other.label).join(", ")}. Replace turns{" "}
          {clashes.length === 1 ? "it" : "them"} off.
        </p>
      )}
      {systemUse && (
        <p
          data-testid="key-capture-system"
          className="flex items-start gap-1.5 text-xs text-status-needs"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          macOS uses {shown} for itself ({systemUse}), so Gram may never see it.
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {!recording && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCapture({ state: "recording" })}
          >
            Record again
          </Button>
        )}
        {capture.state !== "off" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCapture({ state: "off" })}
          >
            Turn off
          </Button>
        )}
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        {clashes.length > 0 ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => save(false)}>
              Keep both
            </Button>
            <Button type="button" size="sm" onClick={() => save(true)}>
              Replace
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" disabled={recording} onClick={() => save(false)}>
            Save
          </Button>
        )}
      </div>
    </DialogShell>
  );
}
