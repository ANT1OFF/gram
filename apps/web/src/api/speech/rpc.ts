import { shellSpeechModels } from "./bridge";
import type { SpeechApi } from "./types";

/** Local model storage stays in the desktop shell. */
export const speechRpc = (): SpeechApi => shellSpeechModels();
