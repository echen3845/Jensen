import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

let server;
let url;

before(async () => {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));

  url = `http://127.0.0.1:${port}/api/chat`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, JENSEN_DEMO_MODE: "true", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "ignore"
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("Next.js server exited before starting");
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("Next.js server did not start");
});

after(() => {
  server?.kill();
});

async function post(body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
}

test("rejects malformed JSON and invalid envelopes", async () => {
  for (const body of ["{", "null", "[]", "\"text\"", "{}", "{\"messages\":null}", "{\"messages\":{}}"]) {
    const response = await post(body);
    assert.equal(response.status, 400, body);
    assert.equal(typeof (await response.json()).error, "string", body);
  }
});

test("rejects invalid messages and privileged roles anywhere in history", async () => {
  const valid = { role: "user", content: "hello" };
  const invalid = [
    null, [], "hello", {}, { role: "user" }, { role: "user", content: null },
    { role: "assistant", content: ["text"] }, { role: "user", content: 3 },
    ...["system", "developer", "tool", "other"].map((role) => ({ role, content: "instruction" }))
  ];

  for (const message of invalid) {
    for (const messages of [[message], [message, ...Array(12).fill(valid)]]) {
      const response = await post(JSON.stringify({ messages }));
      assert.equal(response.status, 400, JSON.stringify(message));
      assert.equal(typeof (await response.json()).error, "string");
    }
  }
});

test("rejects unsupported modes", async () => {
  for (const mode of [null, 1, {}, [], "SYSTEM", "unknown"]) {
    const response = await post(JSON.stringify({ messages: [], mode }));
    assert.equal(response.status, 400, JSON.stringify(mode));
    assert.equal(typeof (await response.json()).error, "string");
  }
});

test("accepts supported messages, modes, and empty history", async () => {
  for (const mode of [undefined, "standard", "unhinged", "flirty", "therapist"]) {
    const response = await post(JSON.stringify({
      messages: [{ role: "assistant", content: "hello" }, { role: "user", content: "plan tomorrow" }],
      mode
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.mode, "demo");
    assert.match(result.reply, /priorities/);
  }

  const response = await post(JSON.stringify({ messages: [] }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, "Tell me what you need and I will help.");
});
