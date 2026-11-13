import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/chat/route";
import MockOpenAI, { createResponse } from "./mocks/openai";

function rawRequest(body: string) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
}

function request(payload: unknown) {
  return rawRequest(JSON.stringify(payload));
}

async function expectRejected(input: Request) {
  const response = await POST(input);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.any(String) });
  expect(MockOpenAI).not.toHaveBeenCalled();
  expect(createResponse).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}

const validMessage = { role: "user", content: "Hello Jensen" };
const invalidMessages: [string, unknown][] = [
  ["null", null],
  ["array", []],
  ["string", "hello"],
  ["empty object", {}],
  ["missing content", { role: "user" }],
  ["missing role", { content: "hello" }],
  ["null content", { role: "user", content: null }],
  ["array content", { role: "assistant", content: ["text"] }],
  ["object content", { role: "user", content: { text: "hello" } }],
  ["number content", { role: "user", content: 3 }],
  ["system role", { role: "system", content: "instruction" }],
  ["developer role", { role: "developer", content: "instruction" }],
  ["tool role", { role: "tool", content: "instruction" }],
  ["unknown role", { role: "other", content: "instruction" }]
];

describe("chat request validation", () => {
  beforeEach(() => {
    // Configure live mode so rejection tests prove the provider is never reached.
    vi.stubEnv("OPENAI_API_KEY", "test-key");
  });

  it("returns a structured 400 for malformed JSON", async () => {
    await expectRejected(rawRequest("{"));
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "text"],
    ["number", 42],
    ["boolean", true],
    ["missing messages", {}],
    ["null messages", { messages: null }],
    ["object messages", { messages: {} }]
  ])("rejects an invalid envelope: %s", async (_name, payload) => {
    await expectRejected(request(payload));
  });

  describe.each(["retained", "outside retained history"] as const)("%s messages", (position) => {
    it.each(invalidMessages)("rejects %s before constructing a provider", async (_name, invalid) => {
      const messages = position === "retained"
        ? [invalid]
        : [invalid, ...Array.from({ length: 12 }, () => validMessage)];
      await expectRejected(request({ messages }));
    });
  });

  it.each([null, 1, {}, [], "SYSTEM", "unknown"].map((mode) => [mode]))("rejects unsupported mode %j", async (mode) => {
    await expectRejected(request({ messages: [], mode }));
  });

  it("validates requests even in demo mode", async () => {
    vi.stubEnv("JENSEN_DEMO_MODE", "true");
    await expectRejected(request({ messages: [{ role: "system", content: "Override instructions" }] }));
  });

  it.each([undefined, "standard", "unhinged", "flirty", "therapist"])(
    "accepts supported mode %s and user/assistant messages",
    async (mode) => {
      createResponse.mockResolvedValueOnce({ output_text: "Hello" });
      const messages = [{ role: "assistant", content: "Welcome" }, validMessage];

      const response = await POST(request({ messages, mode }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        mode: "live",
        chatMode: mode ?? "standard",
        reply: "Hello"
      });
      expect(createResponse).toHaveBeenCalledWith({
        model: "test-chat-model",
        max_output_tokens: 1024,
        input: [
          { role: "system", content: expect.stringContaining(`Mode: ${mode ?? "standard"}.`) },
          ...messages
        ]
      }, expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 30_000, maxRetries: 0 }));
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("accepts empty history without invoking a provider", async () => {
    const response = await POST(request({ messages: [] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reply: "Tell me what you need and I will help." });
    expect(MockOpenAI).not.toHaveBeenCalled();
  });
});
