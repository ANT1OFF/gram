// What an utterance's audio goes through before the offline model hears it. Pure, so the choices
// are tested without a native runtime; `service.ts` drives it and `sherpa.ts` supplies the models.

const RATE = 16_000;

/** Longest clip the offline model gets: decode time grows with it, about 1.5 s for 30 s of audio. */
export const MAX_CLIP_SAMPLES = 30 * RATE;

/**
 * Audio kept around the speech the detector found. It reports a word's onset late and its fade
 * early, and the transducer drops a word that starts on the clip's first sample. 250 ms took 3.74 %
 * WER back to the unpadded clips' 3.04 % on LibriSpeech with a second of quiet noise around it.
 */
const SPEECH_PADDING_SAMPLES = Math.round(0.25 * RATE);

/** How near the clip's end speech must reach for the speaker to count as still talking. */
const STILL_TALKING_SAMPLES = Math.round(0.1 * RATE);

/** A run of speech in a clip, as sample offsets; `end` is exclusive. */
export interface SpeechSegment {
  readonly start: number;
  readonly end: number;
}

/** Audio gathered frame by frame until the utterance ends. */
export interface Utterance {
  push(samples: Float32Array): void;
  readonly length: () => number;
  /** All of it as one clip, leaving the utterance empty. */
  take(): Float32Array;
}

export const createUtterance = (): Utterance => {
  let frames: Float32Array[] = [];
  let length = 0;
  return {
    push: (samples) => {
      frames.push(samples);
      length += samples.length;
    },
    length: () => length,
    take: () => {
      const clip = new Float32Array(length);
      let at = 0;
      for (const frame of frames) {
        clip.set(frame, at);
        at += frame.length;
      }
      frames = [];
      length = 0;
      return clip;
    },
  };
};

/** What to do with a finished utterance's clip. */
export interface ClipPlan {
  /** The part to transcribe, or undefined when nobody spoke in it. */
  readonly speech: SpeechSegment | undefined;
  /** Where the audio to carry into the next utterance starts; absent when none is. */
  readonly carryFrom?: number | undefined;
}

const padded = (first: number, last: number, length: number): SpeechSegment => ({
  start: Math.max(0, first - SPEECH_PADDING_SAMPLES),
  end: Math.min(length, last + SPEECH_PADDING_SAMPLES),
});

/**
 * Trims a clip of `length` samples down to its speech. An utterance that ran long is cut off
 * whatever the speaker was doing, often mid-word; when `more` is coming and speech reaches the
 * clip's end, the clip stops at the last pause and the rest is carried forward, since half a word
 * either side of a cut is two wrong words.
 */
export const planClip = (
  segments: readonly SpeechSegment[],
  length: number,
  more: boolean,
): ClipPlan => {
  const first = segments[0];
  const last = segments.at(-1);
  if (first === undefined || last === undefined) return { speech: undefined };
  const previous = segments.at(-2);
  if (more && previous !== undefined && length - last.end <= STILL_TALKING_SAMPLES) {
    return {
      speech: padded(first.start, previous.end, length),
      carryFrom: Math.max(0, last.start - SPEECH_PADDING_SAMPLES),
    };
  }
  return { speech: padded(first.start, last.end, length) };
};
