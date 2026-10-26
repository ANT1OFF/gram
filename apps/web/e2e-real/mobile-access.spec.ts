// Real server + disposable fake-agent data, through an HTTPS proxy preserving Host and Origin.
// This is browser/proxy qualification, not real-phone or Tailscale policy acceptance.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { createServer as createTcpServer, type Socket } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startHarness, type Harness } from "./harness";

test.use({
  launchOptions: {
    ...(process.env["GRAM_E2E_CHROMIUM"]
      ? { executablePath: process.env["GRAM_E2E_CHROMIUM"] }
      : {}),
    args: ["--host-resolver-rules=MAP device.tail123.ts.net 127.0.0.1", "--no-proxy-server"],
  },
});

test("phone pairs without leaking a navigation secret, reads, sends and reconnects over authenticated WSS", async ({
  browser,
}, info) => {
  const temp = mkdtempSync(join(tmpdir(), "gram-mobile-tls-"));
  let h: Harness | undefined;
  let backend = "";
  const paths: string[] = [];
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(temp, "key.pem"),
      "-out",
      join(temp, "cert.pem"),
      "-subj",
      "/CN=device.tail123.ts.net",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const proxy = createServer(
    { key: readFileSync(join(temp, "key.pem")), cert: readFileSync(join(temp, "cert.pem")) },
    (request, response) => {
      paths.push(request.url!);
      const upstream = httpRequest(
        `${backend}${request.url}`,
        {
          method: request.method,
          headers: {
            ...request.headers,
            "x-forwarded-host": request.headers.host!,
            "x-forwarded-proto": "https",
          },
        },
        (incoming) => {
          response.writeHead(incoming.statusCode!, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    },
  );
  const sockets = new Set<Socket>();
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("upgrade", (request, socket, head) => {
    paths.push(request.url!);
    const upstream = httpRequest(`${backend}${request.url}`, {
      headers: {
        ...request.headers,
        "x-forwarded-host": request.headers.host!,
        "x-forwarded-proto": "https",
      },
    });
    upstream.on("upgrade", (response, target, targetHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (targetHead.length) socket.write(targetHead);
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
      socket.on("error", () => target.destroy());
      target.on("error", () => socket.destroy());
      socket.on("close", () => target.destroy());
    });
    upstream.on("response", (response) => {
      socket.end(`HTTP/1.1 ${response.statusCode} Refused\r\nConnection: close\r\n\r\n`);
      response.resume();
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("no HTTPS port");
  const origin = `https://device.tail123.ts.net:${address.port}`;
  const desktop = await browser.newContext();
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
  });
  try {
    // Fix the disposable backend port: the durable credential is deliberately port-bound.
    const reservation = createTcpServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const reserved = reservation.address();
    if (!reserved || typeof reserved === "string") throw new Error("no backend port");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    h = await startHarness({
      agentAuth: "signed-in",
      env: {
        GRAM_REMOTE_ORIGIN: origin,
        GRAM_PORT: String(reserved.port),
      },
    });
    backend = h.origin_url();
    const local = await desktop.newPage();
    await h.open(local, "/new");
    await local.getByRole("combobox", { name: "Project path" }).fill(h.repo);
    await expect(local.getByTestId("folder-status")).toBeVisible();
    await local.getByRole("combobox", { name: "First prompt" }).fill("mobile seed");
    await local.getByRole("button", { name: "Create thread" }).click();
    await expect(local).toHaveURL(/\/t\/[^/]+$/, { timeout: 30_000 });
    await expect(local.getByText("echo: mobile seed")).toBeVisible();
    const threadPath = new URL(local.url()).pathname;
    const mint = async () => {
      const response = await local.request.post(`${backend}/remote/pair`, {
        headers: { origin: backend },
      });
      expect(response.status()).toBe(200);
      return (await response.json()).url as string;
    };
    const page = await phone.newPage();
    expect((await page.goto(origin))!.status()).toBe(401);
    const link = await mint();
    const code = new URLSearchParams(new URL(link).hash.slice(1)).get("pair")!;
    await page.goto(link);
    await expect(page).toHaveURL(`${origin}/`);
    const cookies = await phone.cookies();
    const remoteCookie = cookies.find((cookie) => cookie.name.startsWith("__Host-gram_remote_"))!;
    expect(remoteCookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
    });
    expect(cookies.some((cookie) => cookie.name.startsWith("sb_token_"))).toBe(false);
    expect(remoteCookie.expires).toBeGreaterThan(Date.now() / 1000 + 364 * 24 * 60 * 60);
    await page.goto(`${origin}${threadPath}`);
    await expect(page.getByText("echo: mobile seed")).toBeVisible();
    const composer = page.getByRole("combobox", { name: "Message" });
    await composer.fill("mobile synthetic send");
    await composer.press("Enter");
    await expect(page.getByText("echo: mobile synthetic send")).toBeVisible();
    await phone.setOffline(true);
    await phone.setOffline(false);
    await page.reload();
    await expect(page.getByText("echo: mobile synthetic send")).toBeVisible();
    await composer.fill("mobile after reconnect");
    await composer.press("Enter");
    await expect(page.getByText("echo: mobile after reconnect")).toBeVisible();
    await page.screenshot({ path: info.outputPath("mobile-thread.png"), fullPage: true });
    expect(paths.some((path) => path === "/ws")).toBe(true);
    expect(
      paths.some((path) => path.includes(code) || path.includes("pair=") || path.includes("boot=")),
    ).toBe(false);
    const replay = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const replayPage = await replay.newPage();
      await replayPage.goto(link);
      await expect(replayPage.getByText("Pairing refused.", { exact: false })).toBeVisible();
      expect(new URL(replayPage.url()).hash).toBe("");
      expect(await replay.cookies()).toHaveLength(0);
    } finally {
      await replay.close();
    }
    // An invitation cannot replace a browser which already has an authenticated session.
    await page.goto(await mint());
    await expect(page.getByText("Pairing refused.", { exact: false })).toBeVisible();
    expect((await phone.cookies()).find((cookie) => cookie.name === remoteCookie.name)?.value).toBe(
      remoteCookie.value,
    );
    const unusedInvitation = await mint();
    await h.restart();
    expect(h.origin_url()).toBe(backend);
    // The preceding rejected invitation left this tab on /remote/connect. Navigate back
    // to the actual conversation to test authentication, rather than reload the bridge.
    expect((await page.goto(`${origin}${threadPath}`))!.status()).toBe(200);
    await expect(page.getByText("echo: mobile after reconnect")).toBeVisible();
    await composer.fill("mobile after restart");
    await composer.press("Enter");
    await expect(page.getByText("echo: mobile after restart")).toBeVisible();
    expect((await phone.cookies()).find((cookie) => cookie.name === remoteCookie.name)?.value).toBe(
      remoteCookie.value,
    );
    const stale = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const stalePage = await stale.newPage();
      await stalePage.goto(unusedInvitation);
      await expect(stalePage.getByText("Pairing refused.", { exact: false })).toBeVisible();
      expect(await stale.cookies()).toHaveLength(0);
    } finally {
      await stale.close();
    }
    // Only the exact disposable server PID is crashed; no real app or provider is involved.
    process.kill(h.pid()!, "SIGKILL");
    await h.restart();
    await page.reload();
    await expect(page.getByText("echo: mobile after restart")).toBeVisible();
    // Offline reset runs after the harness observed actual owning server EXIT, closing WSS.
    await h.restart(() => rmSync(join(h!.root, "data", "remote-access"), { recursive: true }));
    expect((await page.goto(`${origin}${threadPath}`))!.status()).toBe(401);
    expect(paths.some((path) => path.includes(remoteCookie.value))).toBe(false);
  } finally {
    await Promise.allSettled([phone.close(), desktop.close()]);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await h?.stop();
    rmSync(temp, { recursive: true, force: true });
  }
});
