/**
 * The most worker machines the app relays at once, and the longest `relays` list it takes: a
 * longer one is dropped whole, so the server never sends more.
 */
export const WORKER_MACHINE_RELAYS_MOST = 64;
