import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as chat } from "../app/api/chat/route";
import { POST as transcribe } from "../app/api/transcribe/route";
import { getResourceLimits } from "../lib/resource-limits";
import { readLimitedBody, withDeadline } from "../lib/request-resources";
import MockOpenAI, { createResponse, createTranscription } from "./mocks/openai";
import { wavFile } from "./fixtures/audio";

const encoder = new TextEncoder();
function chatRequest(content = "Hello", init: RequestInit = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content }] }), ...init
  });
}
function upload(file: File, init: RequestInit = {}) {
  const body = new FormData();
  body.append("audio", file);
  return new Request("http://localhost/api/transcribe", { method: "POST", body, ...init });
}
function streamed(chunks: string[], headers: Record<string, string>, cancel = vi.fn()) {
  return new Request("http://localhost/api/chat", {
    method: "POST", headers,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      },
      cancel
    }),
    duplex: "half"
  } as RequestInit);
}

afterEach(() => vi.useRealTimers());

describe("streamed request limits", () => {
  it.each<Record<string, string>>([{}, { "content-length": "1" }])("checks actual bytes when headers are %j", async (headers) => {
    vi.stubEnv("JENSEN_CHAT_BODY_BYTES", "64");
    const cancel = vi.fn();
    const response = await chat(streamed(["x".repeat(32), "x".repeat(33)], {
      "content-type": "application/json", ...headers
    }, cancel));
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalled();
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("accepts exactly the byte limit and rejects the next byte", async () => {
    const bytes = encoder.encode("hello");
    const accepted = new Request("http://localhost", { method: "POST", body: bytes });
    expect(await readLimitedBody(accepted, 5, new AbortController().signal)).toEqual(bytes);
    const rejected = new Request("http://localhost", { method: "POST", body: bytes });
    await expect(readLimitedBody(rejected, 4, new AbortController().signal)).rejects.toMatchObject({ status: 413 });
  });

  it("rejects an excessive declared length without reading the stream", async () => {
    const response = await chat(chatRequest("Hello", {
      headers: { "content-type": "application/json", "content-length": "9999999" }
    }));
    expect(response.status).toBe(413);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { "content-type": "text/plain" },
    { "content-type": "application/json", "content-encoding": "gzip" }
  ])("rejects unsupported request types and encodings: %j", async (headers) => {
    expect((await chat(chatRequest("Hello", { headers }))).status).toBe(415);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("times out a stalled body and cancels its reader", async () => {
    vi.stubEnv("JENSEN_BODY_TIMEOUT_MS", "10");
    const cancel = vi.fn();
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({ cancel }),
      duplex: "half"
    } as RequestInit);
    expect((await chat(request)).status).toBe(408);
    expect(cancel).toHaveBeenCalled();
    expect(MockOpenAI).not.toHaveBeenCalled();
  });
});

describe("model budgets and execution deadlines", () => {
  it("rejects excessive message counts before truncating context", async () => {
    const response = await chat(chatRequest("", { body: JSON.stringify({
      messages: Array.from({ length: 33 }, () => ({ role: "user", content: "Hi" }))
    }) }));
    expect(response.status).toBe(413);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    vi.stubEnv("JENSEN_MESSAGE_BYTES", "8");
    expect((await chat(chatRequest("\u{1F600}\u{1F600}\u{1F600}"))).status).toBe(413);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("accepts a message exactly at its byte boundary", async () => {
    vi.stubEnv("JENSEN_MESSAGE_BYTES", "8");
    vi.stubEnv("JENSEN_DEMO_MODE", "true");
    expect((await chat(chatRequest("\u{1F600}\u{1F600}"))).status).toBe(200);
  });

  it("rejects a latest message that cannot fit the model input budget", async () => {
    vi.stubEnv("JENSEN_MODEL_INPUT_BYTES", "512");
    expect((await chat(chatRequest("a".repeat(1000)))).status).toBe(413);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("prunes oldest messages to fit the total input budget and caps output", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("JENSEN_MODEL_INPUT_BYTES", "1000");
    vi.stubEnv("JENSEN_MODEL_OUTPUT_TOKENS", "64");
    vi.stubEnv("JENSEN_PROVIDER_RETRIES", "1");
    createResponse.mockResolvedValueOnce({ output_text: "Done" });
    const messages = Array.from({ length: 12 }, (_, i) => ({ role: "user", content: i + "a".repeat(100) }));
    expect((await chat(chatRequest("", { body: JSON.stringify({ messages }) }))).status).toBe(200);
    const params = createResponse.mock.calls[0][0] as {
      input: { role: string; content: string }[]; max_output_tokens: number
    };
    expect(params.input.at(-1)).toEqual(messages.at(-1));
    expect(params.input.length).toBeLessThan(13);
    expect(params.input.reduce((total, message) => total + encoder.encode(message.content).byteLength + 128, 0)).toBeLessThanOrEqual(1000);
    expect(params.max_output_tokens).toBe(64);
    expect(createResponse.mock.calls[0][1]).toMatchObject({ maxRetries: 1, timeout: 30_000 });
  });

  it("bounds even a provider that never resolves and aborts its signal", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("JENSEN_PROVIDER_TIMEOUT_MS", "10");
    createResponse.mockImplementationOnce(() => new Promise(() => {}));
    expect((await chat(chatRequest())).status).toBe(504);
    const options = createResponse.mock.calls[0][1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(true);
  });

  it("propagates client cancellation to the provider", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const controller = new AbortController();
    createResponse.mockImplementationOnce(() => {
      controller.abort();
      return new Promise(() => {});
    });
    expect((await chat(chatRequest("Hello", { signal: controller.signal }))).status).toBe(499);
    expect((createResponse.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true);
  });

  it("rejects a pre-cancelled request without provider work", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await chat(chatRequest("Hello", { signal: controller.signal }))).status).toBe(499);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("cleans up deadline timers and cancellation listeners on success", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    expect(await withDeadline(parent.signal, 100, async () => "done")).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("fails closed to bounded defaults for invalid configuration", () => {
    vi.stubEnv("JENSEN_CHAT_BODY_BYTES", "Infinity");
    vi.stubEnv("JENSEN_PROVIDER_RETRIES", "999");
    vi.stubEnv("JENSEN_AUDIO_BYTES", "-1");
    expect(getResourceLimits()).toMatchObject({
      chatBodyBytes: 65_536, providerRetries: 0, audioBytes: 4_194_304
    });
  });
});

describe("audio upload limits", () => {
  it("enforces actual multipart bytes without relying on Content-Length", async () => {
    vi.stubEnv("JENSEN_AUDIO_BYTES", "100");
    const response = await transcribe(new Request("http://localhost/api/transcribe", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: new Uint8Array(16_485)
    }));
    expect(response.status).toBe(413);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("rejects a file larger than the audio limit even inside the envelope allowance", async () => {
    vi.stubEnv("JENSEN_AUDIO_BYTES", "100");
    expect((await transcribe(upload(wavFile(0.01)))).status).toBe(413);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("accepts a file at the exact byte and duration limits", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("JENSEN_AUDIO_BYTES", String(wavFile().size));
    vi.stubEnv("JENSEN_AUDIO_SECONDS", "1");
    createTranscription.mockResolvedValueOnce({ text: "Hello" });
    expect((await transcribe(upload(wavFile()))).status).toBe(200);
  });

  it("rejects over-duration content even when the byte size is small", async () => {
    vi.stubEnv("JENSEN_AUDIO_SECONDS", "1");
    expect((await transcribe(upload(wavFile(1.001)))).status).toBe(413);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it.each([
    new File(["plain text"], "voice.webm", { type: "audio/webm" }),
    new File(["not audio"], "voice.exe", { type: "application/octet-stream" }),
    wavFile(1, { name: "voice.webm", type: "audio/webm" })
  ])("rejects corrupt, unsupported, or mismatched content (%s)", async (file) => {
    expect((await transcribe(upload(file))).status).toBe(415);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("rejects empty audio", async () => {
    expect((await transcribe(upload(new File([], "voice.wav", { type: "audio/wav" })))).status).toBe(400);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("rejects duplicate audio fields", async () => {
    const body = new FormData();
    body.append("audio", wavFile());
    body.append("audio", wavFile());
    expect((await transcribe(new Request("http://localhost/api/transcribe", { method: "POST", body }))).status).toBe(400);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("rejects malformed multipart uploads", async () => {
    const response = await transcribe(new Request("http://localhost/api/transcribe", {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=invalid" }, body: "bad"
    }));
    expect(response.status).toBe(400);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("bounds transcription execution and aborts its signal", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("JENSEN_PROVIDER_TIMEOUT_MS", "100");
    createTranscription.mockImplementationOnce(() => new Promise(() => {}));
    expect((await transcribe(upload(wavFile()))).status).toBe(504);
    expect((createTranscription.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true);
  });
});
