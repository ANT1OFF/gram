import { net } from "electron";
import type { AnonymousFetch } from "./native-feed.ts";

/**
 * One GET with no cookies, credentials or `gh`: the signed updater's public feed. A body longer
 * than `maxBytes` aborts the request.
 */
export const anonymousFetch: AnonymousFetch = (url, { accept, maxBytes, redirect }) =>
  new Promise((resolve, reject) => {
    const request = net.request({
      url,
      method: "GET",
      credentials: "omit",
      useSessionCookies: false,
      redirect,
    });
    request.setHeader("Accept", accept);
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure = error;
      request.abort();
    };
    const timer = setTimeout(() => fail(new Error("timed out")), 15_000);
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) fail(new Error(`GitHub's answer for ${url} is too large.`));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
      response.on("error", (error: Error) => {
        clearTimeout(timer);
        reject(failure ?? error);
      });
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(failure ?? error);
    });
    request.on("abort", () => reject(failure ?? new Error("aborted")));
    request.end();
  });
