/** `DataTransfer` type carrying a thread id from a sidebar row onto a pane. */
export const THREAD_DRAG_TYPE = "application/x-gram-thread";

/** `DataTransfer` type carrying a pane's index from its header onto another pane, to swap them. */
export const PANE_DRAG_TYPE = "application/x-gram-pane";

export const hasThreadDrag = (event: { dataTransfer: DataTransfer }) =>
  event.dataTransfer.types.includes(THREAD_DRAG_TYPE);

export const hasPaneDrag = (event: { dataTransfer: DataTransfer }) =>
  event.dataTransfer.types.includes(PANE_DRAG_TYPE);
