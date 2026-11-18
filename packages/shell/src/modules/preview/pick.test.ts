import { describe, expect, it } from "vitest";

import { parsePicked } from "./pick.ts";

const URL = "http://localhost:5173/checkout";

describe("parsePicked", () => {
  it("keeps a well-formed pick and rounds its box", () => {
    const picked = parsePicked(
      {
        selector: "form > button.pay",
        tag: "button",
        text: "  Pay\n  now ",
        html: '<button class="pay">Pay now</button>',
        rect: { x: 10.4, y: 20.6, width: 120, height: 40 },
        styles: { display: "flex", color: "rgb(0, 0, 0)", "font-size": "" },
      },
      URL,
    );
    expect(picked).toEqual({
      url: URL,
      selector: "form > button.pay",
      tag: "button",
      text: "Pay now",
      html: '<button class="pay">Pay now</button>',
      rect: { x: 10, y: 21, width: 120, height: 40 },
      styles: { display: "flex", color: "rgb(0, 0, 0)" },
    });
  });

  it("refuses what the page reports that isn't a pick", () => {
    expect(parsePicked(null, URL)).toBeNull();
    expect(parsePicked("button", URL)).toBeNull();
    expect(parsePicked({ selector: "", tag: "a", html: "<a>" }, URL)).toBeNull();
    expect(parsePicked({ selector: "a", tag: 1, html: "<a>" }, URL)).toBeNull();
  });

  it("cuts long strings and drops styles it didn't ask for", () => {
    const picked = parsePicked(
      {
        selector: "a".repeat(1000),
        tag: "div",
        html: "x".repeat(10_000),
        text: "y".repeat(500),
        rect: { x: Number.NaN, y: "1", width: Infinity, height: 3 },
        styles: { display: "z".repeat(500), "--secret": "token", cursor: "pointer" },
      },
      URL,
    );
    expect(picked?.selector).toHaveLength(300);
    expect(picked?.html).toHaveLength(1500);
    expect(picked?.text).toHaveLength(80);
    expect(picked?.rect).toEqual({ x: 0, y: 0, width: 0, height: 3 });
    expect(picked?.styles).toEqual({ display: "z".repeat(120) });
  });
});
