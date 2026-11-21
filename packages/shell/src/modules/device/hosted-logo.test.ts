import { describe, expect, it } from "vitest";
import { fetchHostedLogo, HOSTED_LOGO_RETRY_MS, hostedLogos } from "./hosted-logo.ts";

const ADDRESS = "https://gram.example.com/favicon.svg";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';

const answering =
  (body: BodyInit, type: string, status = 200, seen: Array<RequestInit> = []) =>
  async (_url: string, init: RequestInit) => {
    seen.push(init);
    return new Response(body, { status, headers: { "content-type": type } });
  };

describe("a hosted server's mark, fetched", () => {
  it("is kept as a data: image when it is the image it says, sent without the sign-in", async () => {
    const seen: Array<RequestInit> = [];
    const logo = await fetchHostedLogo(
      { logo_uri: ADDRESS },
      answering(SVG, "image/svg+xml", 200, seen),
    );
    expect(logo).toBe(`data:image/svg+xml;base64,${btoa(SVG)}`);
    expect(seen[0]).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(new Headers(seen[0]?.headers).has("authorization")).toBe(false);
  });

  it("is gone without for anything that isn't an image, an error, or too much", async () => {
    for (const fetch of [
      answering(SVG, "text/html"),
      answering("<html><script>alert(1)</script></html>", "image/svg+xml"),
      answering(SVG, "image/svg+xml", 404),
      answering(`<svg>${" ".repeat(20_000)}</svg>`, "image/svg+xml"),
      async () => {
        throw new TypeError("redirect");
      },
    ])
      expect(await fetchHostedLogo({ logo_uri: ADDRESS }, fetch)).toBeUndefined();
  });

  it("is fetched once while it lasts, and again a while after it couldn't be had", async () => {
    let now = 0;
    let calls = 0;
    const logos = hostedLogos(() => now);
    const failing = async () => {
      calls += 1;
      return new Response("", { status: 503 });
    };
    expect(await logos("https://gram.example.com", { logo_uri: ADDRESS }, failing)).toBeUndefined();
    await logos("https://gram.example.com", { logo_uri: ADDRESS }, failing);
    expect(calls).toBe(1);
    now += HOSTED_LOGO_RETRY_MS;
    await logos("https://gram.example.com", { logo_uri: ADDRESS }, failing);
    expect(calls).toBe(2);
  });
});
