import { describe, expect, it, vi } from "vitest";
import { POST as chat } from "../app/api/chat/route";
import { POST as transcribe } from "../app/api/transcribe/route";
import { createResponse, createTranscription } from "./mocks/openai";
import { wavFile } from "./fixtures/audio";

describe("API error contract", () => {
  it.each([
    [429, "rate_limit_exceeded", 429, "provider_rate_limited"],
    [429, "insufficient_quota", 503, "provider_billing"],
    [401, "invalid_api_key", 503, "provider_configuration"],
    [403, "forbidden", 503, "provider_configuration"],
    [500, "server_error", 502, "provider_unavailable"],
    [400, "invalid_request_error", 502, "provider_unavailable"]
  ])("classifies provider %s/%s on both endpoints", async (status, providerCode, expectedStatus, expectedCode) => {
    vi.stubEnv("OPENAI_API_KEY", "private-key");
    const failure = { status, code: providerCode, message: "private-key private-email@example.test", headers: new Headers({ "retry-after": "5" }) };
    createResponse.mockRejectedValueOnce(failure);
    createTranscription.mockRejectedValueOnce(failure);
    const form = new FormData();
    form.append("audio", wavFile());
    const responses = [
      await chat(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "private prompt" }] }) })),
      await transcribe(new Request("http://localhost/api/transcribe", { method: "POST", body: form }))
    ];
    for (const response of responses) {
      const body = await response.json();
      expect(response.status).toBe(expectedStatus);
      expect(body).toMatchObject({ ok: false, code: expectedCode, requestId: expect.any(String), retryable: expect.any(Boolean) });
      expect(response.headers.get("x-request-id")).toBe(body.requestId);
      expect(JSON.stringify(body)).not.toMatch(/private-key|private-email|private prompt/);
      if (expectedCode === "provider_rate_limited") expect(response.headers.get("retry-after")).toBe("5");
    }
    const diagnostics = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(diagnostics).not.toMatch(/private-key|private-email|private prompt/);
    expect(diagnostics).toContain("api_request");
  });
});
