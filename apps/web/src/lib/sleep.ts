/**
 * The web app's one real-time wait, for product code that does mean time (a poll interval, a
 * backoff, a simulated delay in the mock API). Tests never sleep: they wait on the condition or use
 * fake timers, which this follows because it goes through the global `setTimeout`.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
