import { createContext, useContext } from "react";

/**
 * A transcript shown only to be read: a worker kept beside the chat, or one whose worktree is gone.
 * Its messages keep Copy and their time; what would act on the thread (rewind, fork, add to Waiting
 * on you) is left out, so watching a worker can't change it.
 */
export const ReadOnlyTranscript = createContext(false);

export const useReadOnlyTranscript = () => useContext(ReadOnlyTranscript);
