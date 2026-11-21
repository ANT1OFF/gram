// The loopback page a browser sign-in returns to (`signInHosted` in `hosted.ts`): its answers,
// and how what comes back is compared.

import { createHash, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";

/** Compared in constant time, through hashes, so the lengths needn't match. */
export const sameText = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** One plain answer to the browser, kept from caches and referrers. */
export const page = (response: ServerResponse, status: number, text: string) => {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end(text);
};
