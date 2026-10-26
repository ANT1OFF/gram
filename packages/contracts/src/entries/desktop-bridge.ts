// The `window.gram` contract and its menu shortcut ids, with no schema behind it, for the
// shells' main processes. `/desktop` adds the window and speech shapes, which bring Effect.
export * from "../desktop-bridge.ts";
export * from "../notice.ts";
// Type-only, so the entry stays schema-free: the speech and voice members' shapes, for a shell that
// serves them.
export type { DesktopSpeech, SpeechModels } from "../speech-bridge.ts";
export type { DesktopPreview, PreviewBounds, PreviewState } from "../preview.ts";
