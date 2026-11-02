/**
 * Dictation's start and stop tones, made here with Web Audio rather than played from files: two
 * soft sine notes, rising for start and falling for stop. Nothing plays for a discard.
 */

export type Tone = "start" | "stop";

/** The notes of each tone, in Hz: a fourth up for start, the same fourth down for stop. */
const NOTES: Readonly<Record<Tone, readonly [number, number]>> = {
  start: [659.25, 880],
  stop: [880, 659.25],
};
const NOTE_S = 0.07;
/** The loudest a tone gets, at volume 1: well under full scale, since it plays beside speech. */
const PEAK = 0.25;
/** How long the context stays running after a tone; suspended, it holds no output device. */
const IDLE_MS = 2_000;

let context: AudioContext | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;

/** Plays `tone` at `volume`, 0 to 1. Never throws: a missing output device just stays quiet. */
export function playTone(tone: Tone, volume: number): void {
  if (!(volume > 0) || typeof AudioContext === "undefined") return;
  try {
    context ??= new AudioContext({ latencyHint: "interactive" });
    const audio = context;
    void audio.resume();
    const gain = Math.min(1, volume) * PEAK;
    let at = audio.currentTime + 0.01;
    for (const frequency of NOTES[tone]) {
      const oscillator = audio.createOscillator();
      const envelope = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(gain, at + 0.008);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_S);
      oscillator.connect(envelope).connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + NOTE_S + 0.01);
      at += NOTE_S * 0.85;
    }
    clearTimeout(idle);
    idle = setTimeout(() => void audio.suspend(), IDLE_MS);
  } catch (error) {
    console.warn("dictation", error);
  }
}
