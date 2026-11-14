import { DEFAULT_SETTINGS } from "@gram/contracts";
import { expect, test, type WebSocketRoute } from "@playwright/test";

// A synthetic cell speaking the real RPC wire to the built package. Authentication stays at
// the host's HTTP boundary; the refresh callback never supplies a credential to Gram.
test("an embedded session renews after a rejected reconnect, preserving its page", async ({
  page,
}) => {
  let socket: WebSocketRoute | undefined;
  let accepting = true;
  let renewals = 0;
  let subscriptions = 0;
  await page.route("**/cell/?boot=0", (route) => route.fulfill({ status: accepting ? 200 : 401 }));
  await page.route("**/renew", async (route) => {
    renewals++;
    accepting = true;
    await route.fulfill({ status: 200 });
  });
  await page.routeWebSocket("**/cell/ws", (ws) => {
    socket = ws;
    if (!accepting) {
      ws.close({ code: 1008 });
      return;
    }
    const send = (value: unknown) => ws.send(JSON.stringify(value));
    ws.onMessage((data) => {
      const frame = JSON.parse(String(data));
      const success = (value: unknown) =>
        send({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value } });
      if (frame._tag === "Ping") {
        send({ _tag: "Pong" });
        return;
      }
      if (frame._tag !== "Request") return;
      switch (frame.tag) {
        case "settings.get":
          success({ ...DEFAULT_SETTINGS, experimental: { embedding: true } });
          break;
        case "events.subscribe":
          subscriptions++;
          send({
            _tag: "Chunk",
            requestId: frame.id,
            values: [{ type: "threads.snapshot", threads: [] }],
          });
          break;
        case "windows.watch":
          send({ _tag: "Chunk", requestId: frame.id, values: [{ windows: [] }] });
          break;
        case "windows.report":
          success(undefined);
          break;
        // The host's page needs no other data; incidental shell queries return empty lists.
        default:
          success([]);
      }
    });
  });
  await page.goto("/w/acme/govern/limits?session-test");
  const draft = page.getByTestId("fixture-cap");
  await draft.fill("321");
  const address = page.url();
  await expect.poll(() => subscriptions).toBeGreaterThan(0);
  const before = subscriptions;
  accepting = false;
  await socket!.close({ code: 1012, reason: "synthetic router rollout" });
  await expect.poll(() => renewals).toBe(1);
  await expect.poll(() => subscriptions).toBeGreaterThan(before);
  await expect(page.getByTestId("connection-banner")).toHaveCount(0);
  await expect(page.getByTestId("session-expired")).toHaveCount(0);
  await expect(draft).toHaveValue("321");
  await expect(page).toHaveURL(address);
});
