import { describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/chat/route";
import MockOpenAI, { createResponse } from "./mocks/openai";

function chatRequest(messages: { role: "user" | "assistant"; content: string }[], mode?: string) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, mode })
  });
}

const message = { role: "user" as const, content: "Hello Jensen" };

describe("chat provider boundary", () => {
  it("answers in demo mode without constructing a paid provider client", async () => {
    vi.stubEnv("JENSEN_DEMO_MODE", "true");
    vi.stubEnv("OPENAI_API_KEY", "configured-but-unused");

    const response = await POST(chatRequest([message]));
    const body = await response.json();

    expect(body).toMatchObject({ mode: "demo" });
    expect(body.reply).toContain("Demo mode");
    expect(MockOpenAI).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["openai", "xai"])("handles a missing %s key without a provider call", async (provider) => {
    vi.stubEnv("AI_PROVIDER", provider);
    const response = await POST(chatRequest([message]));

    expect((await response.json()).reply).toContain(
      provider === "xai" ? "XAI_API_KEY" : "OPENAI_API_KEY"
    );
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("keeps model context bounded while preserving application instructions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    createResponse.mockResolvedValueOnce({ output_text: "A real tool is not connected yet." });
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`
    }));

    const response = await POST(chatRequest(messages, "standard"));
    expect(await response.json()).toMatchObject({
      reply: "A real tool is not connected yet.",
      mode: "live",
      provider: "openai"
    });
    expect(createResponse).toHaveBeenCalledWith({
      model: "test-chat-model",
      max_output_tokens: 1024,
      input: [
        { role: "system", content: expect.stringContaining("cannot perform yet") },
        ...messages.slice(-12)
      ]
    }, expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 30_000, maxRetries: 0 }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes xAI chat to its configured endpoint and model", async () => {
    vi.stubEnv("AI_PROVIDER", "xai");
    vi.stubEnv("XAI_API_KEY", "test-xai-key");
    createResponse.mockResolvedValueOnce({ output_text: "Hello" });

    const response = await POST(chatRequest([message]));
    expect(await response.json()).toMatchObject({ reply: "Hello", provider: "xai" });
    expect(MockOpenAI).toHaveBeenCalledWith({
      apiKey: "test-xai-key",
      baseURL: "https://api.x.ai/v1",
      timeout: 30_000,
      maxRetries: 0
    });
    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ model: "test-xai-model" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("does not disclose a provider exception or claim a successful response", async () => {
    vi.stubEnv("OPENAI_API_KEY", "private-test-key");
    createResponse.mockRejectedValueOnce(new Error("private-test-key internal provider detail"));

    const response = await POST(chatRequest([message]));
    const body = await response.json();

    expect(body.mode).toBe("error");
    expect(body.reply).not.toContain("private-test-key");
    expect(body.reply).not.toContain("internal provider detail");
  });
});
