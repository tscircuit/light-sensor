import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders an honest disconnected sensor dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Light Stream — Live BH1750 Monitor<\/title>/i);
  assert.match(html, /Not connected/);
  assert.match(html, /Connect Feather/);
  assert.match(html, /Connect your Feather to begin/);
  assert.match(html, /Expected serial format: Light: 123\.45 lux/);
  assert.doesNotMatch(html, /demo signal|try demo|stop demo/i);
});

test("validates compatible BH1750 output and reports failures", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /Light:\\s\*\(\[0-9\]\+/);
  assert.match(page, /const SENSOR_SCRIPT/);
  assert.match(page, /i2c\.writeto\(address, b"\\\\x13"\)/);
  assert.match(page, /writer\.write\(Uint8Array\.of\(13, 3, 3\)\)/);
  assert.match(page, /writer\.write\(Uint8Array\.of\(13, 1\)\)/);
  assert.match(page, /writer\.write\(encoder\.encode\(SENSOR_SCRIPT\)\)/);
  assert.match(page, /writer\.write\(Uint8Array\.of\(4\)\)/);
  assert.match(page, /did not start the BH1750 program within 5 seconds/);
  assert.match(page, /not running the compatible BH1750 script/);
  assert.match(page, /The Feather reported a sensor error/);
  assert.match(page, /stopped sending light readings/);
  assert.match(page, /role="alert"/);
  assert.doesNotMatch(page, /demoMode|Math\.random|Try demo|Demo signal/);
  assert.doesNotMatch(page, /Confirm that device\/main\.py is running/);
  assert.match(css, /\.status-dot\.error/);
  assert.match(css, /\.empty-chart\.error/);
});
