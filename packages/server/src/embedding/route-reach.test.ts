import { describe, expect, it } from "vitest";
import { routeRefusalOf } from "./route-reach.ts";

const answer = (status: string, body: unknown) =>
  `HTTP/2.0 ${status}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;

describe("routeRefusalOf", () => {
  it("takes the route's reason and the page it says fixes it", () => {
    expect(
      routeRefusalOf(
        answer("404 Not Found", {
          message: "acme/web isn't reachable",
          help_url: "https://github.com/apps/example/installations/new",
          help_label: "Install the app",
        }),
      ),
    ).toEqual({
      message: "acme/web isn't reachable",
      help: { url: "https://github.com/apps/example/installations/new", label: "Install the app" },
    });
  });

  it("never offers a page that isn't https, or that carries a credential", () => {
    for (const help_url of ["http://example.com/fix", "javascript:alert(1)", "https://u:p@x.io/"])
      expect(routeRefusalOf(answer("403 Forbidden", { message: "no", help_url }))).toEqual({
        message: "no",
      });
  });

  it("says nothing for an answer that isn't a refusal, so the clone is filed", () => {
    expect(routeRefusalOf(answer("502 Bad Gateway", { message: "down" }))).toBeUndefined();
    expect(routeRefusalOf(answer("200 OK", { full_name: "acme/web" }))).toBeUndefined();
    expect(routeRefusalOf("gh: connection refused")).toBeUndefined();
  });
});
