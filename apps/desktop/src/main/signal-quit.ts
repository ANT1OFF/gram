/** Service signals may ask for ordinary quit once, never escalate an existing shutdown. */
export const createSignalQuit = (idle: () => boolean, ordinaryQuit: () => void) => {
  let requested = false;
  return () => {
    if (requested || !idle()) return;
    requested = true;
    ordinaryQuit();
  };
};
