import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test("creates and lists notes", async () => {
  await withServer(async (base) => {
    const created = await fetch(`${base}/api/notes`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
    assert.equal(created.status, 201);
    const list = await (await fetch(`${base}/api/notes`)).json();
    assert.equal(list.at(-1).text, "hello");
  });
});
