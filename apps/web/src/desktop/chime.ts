import type { ChimeSound } from "@gram/contracts";

import { themeStore } from "@/theme/store";
import { systemSource } from "@/theme/system";
import { resolveMotion, type ResolvedMotion } from "@/theme/theme";

interface Note {
  readonly frequency: number;
  /** Seconds after the sound starts. */
  readonly at: number;
  readonly length: number;
  readonly wave: OscillatorType;
  readonly gain: number;
}

export const CHIME_SOUNDS: Readonly<
  Record<ChimeSound, { readonly label: string; readonly notes: readonly Note[] }>
> = {
  chime: {
    label: "Chime",
    notes: [
      { frequency: 880, at: 0, length: 0.25, wave: "sine", gain: 0.12 },
      { frequency: 1320, at: 0.12, length: 0.25, wave: "sine", gain: 0.12 },
    ],
  },
  bell: {
    label: "Bell",
    notes: [
      { frequency: 660, at: 0, length: 0.9, wave: "triangle", gain: 0.1 },
      { frequency: 1320, at: 0, length: 0.6, wave: "sine", gain: 0.04 },
    ],
  },
  pop: {
    label: "Pop",
    notes: [{ frequency: 520, at: 0, length: 0.08, wave: "sine", gain: 0.16 }],
  },
  marimba: {
    label: "Marimba",
    notes: [
      { frequency: 523.25, at: 0, length: 0.18, wave: "triangle", gain: 0.14 },
      { frequency: 659.25, at: 0.1, length: 0.18, wave: "triangle", gain: 0.14 },
      { frequency: 783.99, at: 0.2, length: 0.3, wave: "triangle", gain: 0.14 },
    ],
  },
};

/** Automatic chimes closer together than this play once. */
export const CHIME_GAP_MS = 1500;

let context: AudioContext | undefined;
let lastScheduledAt = Number.NEGATIVE_INFINITY;

/**
 * Plays `sound` now; `reduced` plays only its first note, softer. Does nothing where Web Audio is
 * unavailable.
 */
export function playChime(sound: ChimeSound, options: { readonly reduced?: boolean } = {}): void {
  try {
    context ??= new AudioContext();
    const start = context.currentTime;
    const { notes } = CHIME_SOUNDS[sound];
    for (const note of options.reduced ? notes.slice(0, 1) : notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = start + note.at;
      const peak = options.reduced ? note.gain * 0.6 : note.gain;
      oscillator.type = note.wave;
      oscillator.frequency.value = note.frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + note.length);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + note.length + 0.05);
    }
  } catch {
    // No audio output: the notification itself still shows.
  }
}

const motionLevel = (): ResolvedMotion =>
  resolveMotion(themeStore.getState().motion, systemSource.get().prefersReducedMotion);

/**
 * The notification chime: `undefined` (None) and Motion Off stay silent, Reduced plays a softer
 * single note. Runs on a later task so it never delays the store update that triggered it, and a
 * burst of notifications chimes once.
 */
export function scheduleChime(sound: ChimeSound | undefined, now = Date.now()): void {
  if (sound === undefined) return;
  const level = motionLevel();
  if (level === "off" || now - lastScheduledAt < CHIME_GAP_MS) return;
  lastScheduledAt = now;
  setTimeout(() => playChime(sound, { reduced: level === "reduced" }), 0);
}

/** Forgets the last chime, for tests. */
export function resetChimeThrottle(): void {
  lastScheduledAt = Number.NEGATIVE_INFINITY;
}
